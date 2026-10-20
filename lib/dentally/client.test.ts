import { describe, expect, it } from 'vitest';
import { DentallyClient, DentallyError } from './client.ts';

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

function fakeFetch(responder: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    calls.push(call);
    return responder(call, calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const noSleep = async () => {};

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof DentallyClient>[0]> = {}) {
  return new DentallyClient({
    baseUrl: 'https://api.sandbox.dentally.co',
    token: 'test-token',
    userAgent: 'AuraNoteTaker/0.1',
    fetchImpl,
    sleep: noSleep,
    ...extra,
  });
}

describe('DentallyClient', () => {
  it('exposes no way to change Dentally data: every public method issues GET only', async () => {
    const { impl, calls } = fakeFetch((c) => {
      if (c.url.pathname.endsWith('/appointments')) return json({ appointments: [], meta: { total_pages: 1 } });
      if (c.url.pathname.includes('/appointments/')) return json({ appointment: { id: 1 } });
      if (c.url.pathname.includes('/patients/')) return json({ patient: { id: 1 } });
      return json({ practitioners: [], rooms: [], sites: [] });
    });
    const c = client(impl);
    const publicMethods = Object.getOwnPropertyNames(DentallyClient.prototype).filter((m) => m !== 'constructor');
    expect(publicMethods.sort()).toEqual(
      ['getAppointment', 'getPatient', 'listAppointments', 'listPractitioners', 'listRooms', 'listSites', 'ping'].sort(),
    );
    await c.listAppointments({ on: '2026-10-20' });
    await c.getAppointment('1');
    await c.getPatient('1');
    await c.listPractitioners();
    await c.listRooms();
    await c.listSites();
    await c.ping();
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(new Set(calls.map((x) => x.method))).toEqual(new Set(['GET']));
  });

  it('sends the bearer token and the mandatory User-Agent', async () => {
    const { impl, calls } = fakeFetch(() => json({ sites: [] }));
    await client(impl).ping();
    expect(calls[0]!.headers['Authorization']).toBe('Bearer test-token');
    expect(calls[0]!.headers['User-Agent']).toBe('AuraNoteTaker/0.1');
  });

  it('filters appointments by date and excludes cancelled ones, following pagination', async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i }));
    const { impl, calls } = fakeFetch((c) => {
      const p = Number(c.url.searchParams.get('page'));
      return json({ appointments: p === 1 ? page(1, 100) : page(2, 3), meta: { total_pages: 2 } });
    });
    const items = await client(impl).listAppointments({ on: '2026-10-20', practitionerId: '42', siteId: '7' });
    expect(items).toHaveLength(103);
    expect(calls).toHaveLength(2);
    const q = calls[0]!.url.searchParams;
    expect(q.get('on')).toBe('2026-10-20');
    expect(q.get('practitioner_id')).toBe('42');
    expect(q.get('site_id')).toBe('7');
    expect(q.get('cancelled')).toBe('false');
    expect(q.get('per_page')).toBe('100');
  });

  it('refuses to return a silently truncated list when pagination never ends', async () => {
    const { impl } = fakeFetch(() => json({ appointments: Array.from({ length: 100 }, (_, i) => ({ id: i })) }));
    await expect(client(impl).listAppointments({ on: '2026-10-20' })).rejects.toMatchObject({ kind: 'BAD_RESPONSE' });
  });

  it('retries temporary failures with backoff, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = fakeFetch((_c, n) => (n === 1 ? json({}, 503) : n === 2 ? json({}, 429, { 'retry-after': '2' }) : json({ sites: [] })));
    await client(impl, { sleep: async (ms) => void sleeps.push(ms) }).ping();
    expect(calls).toHaveLength(3);
    expect(sleeps[1]).toBe(2000);
  });

  it('gives up after the retry budget with an UNAVAILABLE error', async () => {
    const { impl, calls } = fakeFetch(() => json({}, 502));
    await expect(client(impl, { maxRetries: 2 }).ping()).rejects.toMatchObject({ kind: 'UNAVAILABLE', status: 502 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry authentication failures, and reports them without the response body', async () => {
    const { impl, calls } = fakeFetch(() => json({ error: 'secret detail about patient 123' }, 401));
    const err = await client(impl).ping().catch((e) => e);
    expect(err).toBeInstanceOf(DentallyError);
    expect(err.kind).toBe('AUTH');
    expect(err.message).not.toContain('patient 123');
    expect(calls).toHaveLength(1);
  });

  it('maps 404 on a single record to null', async () => {
    const { impl } = fakeFetch(() => json({}, 404));
    await expect(client(impl).getPatient('99')).resolves.toBeNull();
  });

  it('times out slow requests', async () => {
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    await expect(client(impl, { timeoutMs: 20, maxRetries: 0 }).ping()).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('rejects unsafe identifiers before any request is made', async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    await expect(client(impl).getPatient('../admin')).rejects.toMatchObject({ kind: 'CONFIG' });
    expect(calls).toHaveLength(0);
  });

  it('requires https, a token and a User-Agent', () => {
    const f = fakeFetch(() => json({})).impl;
    expect(() => client(f, { baseUrl: 'http://api.dentally.co' })).toThrow(DentallyError);
    expect(() => client(f, { token: '' })).toThrow(DentallyError);
    expect(() => client(f, { userAgent: '' })).toThrow(DentallyError);
  });

  it('reports request metrics with route labels only (no IDs or query values)', async () => {
    const routes: string[] = [];
    const { impl } = fakeFetch(() => json({ patient: { id: 5 } }));
    await client(impl, { onRequest: (i) => void routes.push(i.route) }).getPatient('12345');
    expect(routes).toEqual(['/v1/patients/:id']);
  });
});
