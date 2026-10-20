// Connected backend: Base44 authentication and backend functions.
// Not yet exercised against a live Base44 app (issue P1-01).

import { createClient, getAccessToken } from '@base44/sdk';
import type { AppBackend, CurrentUser } from './types.ts';
import { BackendError } from './types.ts';

const DEVICE_KEY = 'auranotetaker.device-id';
/** Longest wait for any backend function. Confirmation re-checks Dentally, so allow for its retries. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A random ID per browser, used to spot two screens working on one session. Not personal data. */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return 'unknown-device';
  }
}

export function createBase44Backend(cfg: { appId: string; serverUrl?: string }): AppBackend {
  const base44 = createClient({
    appId: cfg.appId,
    ...(cfg.serverUrl ? { serverUrl: cfg.serverUrl } : {}),
    // No analytics or heartbeat traffic from a clinical app.
    analytics: { enabled: false },
  });
  const device = deviceId();
  const serverUrl = (cfg.serverUrl ?? 'https://base44.app').replace(/\/$/, '');

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-App-Id': cfg.appId, 'X-Device-Id': device };
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function call<T>(name: string, data: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    // A request that never answers must fail, not leave buttons waiting for ever: callers retry on the next refresh.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BackendError('TIMEOUT', 'AuraNoteTaker\'s server took too long to answer. Try again.'));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      res = await Promise.race([
        // The SDK's functions.fetch posts to /api/functions/<name> without the app ID, which Base44 answers
        // with 404. Use the same route as functions.invoke, which carries the app ID in the path.
        fetch(`${serverUrl}/api/apps/${encodeURIComponent(cfg.appId)}/functions/${name}`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(data),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError('NETWORK', 'AuraNoteTaker cannot reach its server. Check the internet connection.');
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    if (!res.ok) {
      const e = body?.error;
      throw new BackendError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `The server returned an error (${res.status}).`, e?.details ?? {});
    }
    return body as T;
  }

  return {
    mode: 'base44',
    async getCurrentUser(): Promise<CurrentUser | null> {
      if (!(await base44.auth.isAuthenticated())) return null;
      return call<CurrentUser>('getMe');
    },
    async signIn() {
      base44.auth.redirectToLogin(window.location.href);
    },
    async signOut() {
      base44.auth.logout(window.location.origin);
    },
    getSetupOptions: () => call('getSetupOptions'),
    getDiary: (practitionerId, reason) => call('getDiary', { practitionerId, reason }),
    getPatientSummary: (appointmentId) => call('getPatientSummary', { appointmentId }),
    confirmPatient: (input) => call('confirmPatient', { ...input }),
    recordConsent: (sessionId, given, expectedVersion, surgeryId) => call('recordConsent', { sessionId, given, expectedVersion, surgeryId }),
    cancelSession: (sessionId, expectedVersion) => call('cancelSession', { sessionId, expectedVersion }),
    getActiveSession: (surgeryId, practitionerId) => call('getActiveSession', { surgeryId, practitionerId }),
    getSessionPatient: (sessionId) => call('getSessionPatient', { sessionId }),
    bootstrapClinic: (clinicName) => call('bootstrapClinic', { clinicName }),
    getClinicSetup: () => call('getClinicSetup'),
    saveClinicians: (clinicians) => call('saveClinicians', { clinicians }),
    saveSurgeries: (surgeries) => call('saveSurgeries', { surgeries }),
    saveStaffProfile: (profile) => call('saveStaffProfile', { ...profile }),
    getDentallyCheck: () => call('getDentallyCheck'),
    listNoteTemplates: (includeInactive = false) => call('listNoteTemplates', { includeInactive }),
    saveNoteTemplate: (t) => call('saveNoteTemplate', { ...t }),
    recordNoteCopied: (input) => call('recordNoteCopied', { ...input }),
    changeRecording: (sessionId, surgeryId, action, expectedVersion) => call('changeRecording', { sessionId, surgeryId, action, expectedVersion }),
    getSpeechToken: (sessionId, surgeryId) => call('getSpeechToken', { sessionId, surgeryId }),
    saveTranscript: (sessionId, surgeryId, segments) => call('saveTranscript', { sessionId, surgeryId, segments }),
    getScribeContent: (sessionId, surgeryId) => call('getScribeContent', { sessionId, surgeryId }),
    saveNurseNote: (sessionId, surgeryId, text, expectedRevision) => call('saveNurseNote', { sessionId, surgeryId, text, expectedRevision }),
  };
}
