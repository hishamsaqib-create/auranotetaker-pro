// Demo backend: runs the real server handlers in the browser against the fictional Dentally
// service and in-memory stores. Nothing leaves the browser and nothing is persisted.

import type { DemoScenario } from '../../lib/dentally/mock.ts';
import { DEMO_PRACTITIONERS, DEMO_ROOMS, DEMO_SCENARIOS, MockDentallyService } from '../../lib/dentally/mock.ts';
import { AppError } from '../../lib/server/errors.ts';
import {
  cancelSession,
  confirmPatient,
  getActiveSession,
  getDiary,
  getMe,
  getPatientSummary,
  getSessionPatient,
  getSetupOptions,
  recordConsent,
} from '../../lib/server/handlers.ts';
import { InMemoryAuditSink, InMemorySessionRepository, StaticClinicDirectory } from '../../lib/server/memory.ts';
import type { AppRole, HandlerDeps, StaffContext } from '../../lib/server/ports.ts';
import type { AppBackend, DemoUser } from './types.ts';
import { BackendError } from './types.ts';

const DEMO_CLINIC_ID = 'DEMO-CLINIC';

interface DemoUserRecord extends DemoUser {
  roles: AppRole[];
  clinicianId: string | null;
}

const DEMO_USERS: readonly DemoUserRecord[] = [
  { email: 'sarah.lin@demo.invalid', displayName: 'Dr Sarah Lin', roleLabel: 'Dentist', roles: ['DENTIST'], clinicianId: 'DEMO-PR1' },
  { email: 'hannah.price@demo.invalid', displayName: 'Hannah Price', roleLabel: 'Dental nurse', roles: ['NURSE'], clinicianId: null },
  { email: 'jo.morgan@demo.invalid', displayName: 'Jo Morgan', roleLabel: 'Practice manager', roles: ['CLINIC_ADMIN'], clinicianId: null },
];

export interface DemoBackendOptions {
  clock?: () => number;
  scenario?: DemoScenario;
  /** Simulated network delay in ms. */
  latencyMs?: number;
}

export function createDemoBackend(opts: DemoBackendOptions = {}): AppBackend {
  const clock = opts.clock ?? (() => Date.now());
  const latency = opts.latencyMs ?? 150;
  const mock = new MockDentallyService({ clock, scenario: opts.scenario ?? 'normal' });
  const audit = new InMemoryAuditSink();
  let ids = 0;

  const deps: HandlerDeps = {
    clock,
    newId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `demo-session-${++ids}`),
    clinic: {
      clinicId: DEMO_CLINIC_ID,
      name: 'Aura Dental Clinic (demo)',
      timeZone: 'Europe/London',
      dentallySiteId: null,
      settings: { earlyStartMinutes: 10, overrunMinutes: 30 },
    },
    dentally: mock,
    sessions: new InMemorySessionRepository(),
    audit,
    directory: new StaticClinicDirectory(
      DEMO_CLINIC_ID,
      DEMO_PRACTITIONERS.map((p) => ({
        practitionerId: p.practitionerId,
        displayName: p.displayName,
        clinicianType: p.practitionerId === 'DEMO-PR3' ? ('HYGIENIST' as const) : ('DENTIST' as const),
      })),
      DEMO_ROOMS.map((r, i) => ({ surgeryId: `DEMO-SURGERY-${i + 1}`, name: r.name, roomId: r.roomId })),
    ),
  };

  let user: DemoUserRecord | null = null;

  const ctx = (): StaffContext => {
    if (!user) throw new BackendError('UNAUTHENTICATED', 'Please sign in.');
    return {
      email: user.email,
      displayName: user.displayName,
      clinicId: DEMO_CLINIC_ID,
      roles: user.roles,
      clinicianId: user.clinicianId,
      deviceId: 'demo-device',
      appVersion: '0.1.0-demo',
    };
  };

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw new BackendError(err.code, err.message, err.details);
      throw err;
    }
  }

  return {
    mode: 'demo',
    demo: {
      users: DEMO_USERS.map(({ email, displayName, roleLabel }) => ({ email, displayName, roleLabel })),
      signInAs(email: string) {
        user = DEMO_USERS.find((u) => u.email === email) ?? null;
      },
      scenarios: DEMO_SCENARIOS,
      getScenario: () => mock.scenario,
      setScenario: (s) => mock.setScenario(s),
      auditEvents: () => audit.events,
      rebook: (appointmentId, patientId) => mock.rebook(appointmentId, patientId),
    },
    async getCurrentUser() {
      if (!user) return null;
      return run(() => getMe(ctx(), deps));
    },
    async signIn() {
      // Demo sign-in happens through demo.signInAs from the sign-in screen.
    },
    async signOut() {
      user = null;
    },
    getSetupOptions: () => run(() => getSetupOptions(ctx(), deps)),
    getDiary: (practitionerId, reason) => run(() => getDiary(ctx(), deps, { practitionerId, reason })),
    getPatientSummary: (appointmentId) => run(() => getPatientSummary(ctx(), deps, { appointmentId })),
    confirmPatient: (input) => run(() => confirmPatient(ctx(), deps, { ...input })),
    recordConsent: (sessionId, given, expectedVersion, surgeryId) =>
      run(() => recordConsent(ctx(), deps, { sessionId, given, expectedVersion, surgeryId })),
    cancelSession: (sessionId, expectedVersion) => run(() => cancelSession(ctx(), deps, { sessionId, expectedVersion })),
    getActiveSession: (surgeryId, practitionerId) => run(() => getActiveSession(ctx(), deps, { surgeryId, practitionerId })),
    getSessionPatient: (sessionId) => run(() => getSessionPatient(ctx(), deps, { sessionId })),
  };
}
