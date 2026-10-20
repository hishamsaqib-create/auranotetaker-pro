// Read-only Dentally v1 API client.
//
// SAFETY and security:
// - Only HTTP GET exists in this class. There is deliberately no generic request method,
//   so a write to Dentally cannot be added by accident (client.test.ts enforces this).
// - Runs server-side only (Base44 function or Node). The token must never reach a browser.
// - Errors carry a kind and status code, never response bodies, so nothing patient-identifiable
//   reaches logs through exceptions.

import { extractList, extractOne, toId, totalPages } from './parse.ts';

export type DentallyErrorKind = 'CONFIG' | 'AUTH' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'BAD_RESPONSE';

export class DentallyError extends Error {
  readonly kind: DentallyErrorKind;
  readonly status: number | null;
  constructor(kind: DentallyErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'DentallyError';
    this.kind = kind;
    this.status = status;
  }
}

export interface DentallyRequestInfo {
  /** Path with IDs replaced by ":id", e.g. "/v1/patients/:id". No query values. */
  route: string;
  status: number | null;
  durationMs: number;
  attempt: number;
}

export interface DentallyClientConfig {
  /** https://api.dentally.co or https://api.sandbox.dentally.co */
  baseUrl: string;
  token: string;
  /** Dentally rejects requests without a User-Agent (403). */
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (info: DentallyRequestInfo) => void;
}

type Query = Record<string, string | number | boolean | null | undefined>;

const PER_PAGE = 100;
const MAX_PAGES = 20;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class DentallyClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onRequest?: (info: DentallyRequestInfo) => void;

  constructor(cfg: DentallyClientConfig) {
    let url: URL;
    try {
      url = new URL(cfg.baseUrl);
    } catch {
      throw new DentallyError('CONFIG', 'Dentally base URL is not a valid URL');
    }
    if (url.protocol !== 'https:') throw new DentallyError('CONFIG', 'Dentally base URL must use https');
    if (!cfg.token) throw new DentallyError('CONFIG', 'Dentally token is missing');
    if (!cfg.userAgent) throw new DentallyError('CONFIG', 'Dentally User-Agent is missing');
    this.#baseUrl = url.origin;
    this.#token = cfg.token;
    this.#userAgent = cfg.userAgent;
    this.#fetch = cfg.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.#timeoutMs = cfg.timeoutMs ?? 8000;
    this.#maxRetries = cfg.maxRetries ?? 2;
    this.#sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#onRequest = cfg.onRequest;
  }

  /** All appointments matching the filters, across pages. Never returns a silently truncated list. */
  async listAppointments(q: { on: string; practitionerId?: string | null; roomId?: string | null; siteId?: string | null }): Promise<unknown[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.on)) throw new DentallyError('CONFIG', 'Appointment date must be YYYY-MM-DD');
    return this.#listAll('/v1/appointments', 'appointments', {
      on: q.on,
      practitioner_id: q.practitionerId ? this.#id(q.practitionerId) : undefined,
      room_id: q.roomId ? this.#id(q.roomId) : undefined,
      site_id: q.siteId ? this.#id(q.siteId) : undefined,
      cancelled: false,
    });
  }

  async getAppointment(appointmentId: string): Promise<unknown | null> {
    return this.#getOne(`/v1/appointments/${this.#id(appointmentId)}`, 'appointment', '/v1/appointments/:id');
  }

  async getPatient(patientId: string): Promise<unknown | null> {
    return this.#getOne(`/v1/patients/${this.#id(patientId)}`, 'patient', '/v1/patients/:id');
  }

  async listPractitioners(): Promise<unknown[]> {
    return this.#listAll('/v1/practitioners', 'practitioners', {});
  }

  async listRooms(): Promise<unknown[]> {
    return this.#listAll('/v1/rooms', 'rooms', {});
  }

  async listSites(): Promise<unknown[]> {
    return this.#listAll('/v1/sites', 'sites', {});
  }

  /** Cheapest authenticated call, for connection status. Returns latency in ms. */
  async ping(): Promise<number> {
    const started = Date.now();
    await this.#get('/v1/sites', { per_page: 1 });
    return Date.now() - started;
  }

  // -------------------------------------------------------------------------

  #id(id: string): string {
    const safe = toId(id);
    if (!safe) throw new DentallyError('CONFIG', 'Invalid Dentally identifier');
    return encodeURIComponent(safe);
  }

  async #getOne(path: string, key: string, route: string): Promise<unknown | null> {
    try {
      return extractOne(await this.#get(path, {}, route), key);
    } catch (err) {
      if (err instanceof DentallyError && err.kind === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async #listAll(path: string, key: string, query: Query): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.#get(path, { ...query, page, per_page: PER_PAGE });
      const list = extractList(body, key);
      if (!list) throw new DentallyError('BAD_RESPONSE', `Unexpected list response from ${path}`);
      items.push(...list);
      const pages = totalPages(body);
      if (list.length < PER_PAGE || (pages !== null && page >= pages)) return items;
    }
    throw new DentallyError('BAD_RESPONSE', `More than ${MAX_PAGES} pages from ${path}; refusing to return a partial list`);
  }

  /** `route` is the path with IDs replaced (e.g. "/v1/patients/:id"); it is the only path information passed to onRequest. */
  async #get(path: string, query: Query, route: string = path): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    let lastError: DentallyError | null = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let res: Response | null = null;
      try {
        res = await this.#fetch(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.#token}`,
            'User-Agent': this.#userAgent,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch {
        lastError = controller.signal.aborted
          ? new DentallyError('TIMEOUT', `Dentally did not respond within ${this.#timeoutMs} ms`)
          : new DentallyError('UNAVAILABLE', 'Could not reach Dentally');
      } finally {
        clearTimeout(timer);
      }
      this.#onRequest?.({ route, status: res?.status ?? null, durationMs: Date.now() - started, attempt });

      if (res) {
        if (res.ok) {
          try {
            return await res.json();
          } catch {
            throw new DentallyError('BAD_RESPONSE', 'Dentally returned a response that is not JSON', res.status);
          }
        }
        if (res.status === 401 || res.status === 403) {
          throw new DentallyError('AUTH', 'Dentally refused the credentials (check the token, its scopes and the User-Agent)', res.status);
        }
        if (res.status === 404) throw new DentallyError('NOT_FOUND', 'Not found in Dentally', 404);
        if (!RETRYABLE_STATUS.has(res.status)) {
          throw new DentallyError('BAD_RESPONSE', `Dentally returned HTTP ${res.status}`, res.status);
        }
        lastError =
          res.status === 429
            ? new DentallyError('RATE_LIMITED', 'Dentally rate limit reached', 429)
            : new DentallyError('UNAVAILABLE', `Dentally returned HTTP ${res.status}`, res.status);
      }

      if (attempt < this.#maxRetries) {
        const retryAfter = Number(res?.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 300 * 3 ** attempt + Math.floor(Math.random() * 100);
        await this.#sleep(backoff);
      }
    }
    throw lastError ?? new DentallyError('UNAVAILABLE', 'Could not reach Dentally');
  }
}
