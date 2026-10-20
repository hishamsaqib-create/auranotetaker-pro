// Connected backend: Base44 authentication and backend functions.
// Not yet exercised against a live Base44 app (issue P1-01).

import { createClient } from '@base44/sdk';
import type { AppBackend, CurrentUser } from './types.ts';
import { BackendError } from './types.ts';

const DEVICE_KEY = 'auranotetaker.device-id';

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

  async function call<T>(name: string, data: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await base44.functions.fetch(`/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': device },
        body: JSON.stringify(data),
      });
    } catch {
      throw new BackendError('NETWORK', 'AuraNoteTaker cannot reach its server. Check the internet connection.');
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
  };
}
