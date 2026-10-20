import type { AuditEvent } from '../../lib/core/audit.ts';
import type { ConfirmationMethod, ScribeSession } from '../../lib/core/session.ts';
import type { DemoScenario } from '../../lib/dentally/mock.ts';
import type {
  DiaryResponse,
  MeResponse,
  PatientSummaryResponse,
  SessionResponse,
  SetupOptionsResponse,
} from '../../lib/server/handlers.ts';

export type { MeResponse as CurrentUser };

export class BackendError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.details = details;
  }
}

export interface ConfirmPatientInput {
  appointmentId: string;
  patientId: string;
  practitionerId: string;
  surgeryId: string | null;
  predictedAppointmentId: string | null;
  method: ConfirmationMethod;
}

export type DiaryReason = 'INITIAL' | 'REFRESH' | 'MANUAL';

/** Everything the web app asks of the backend. Implemented by the demo backend and the Base44 backend. */
export interface AppBackend {
  readonly mode: 'demo' | 'base44';
  getCurrentUser(): Promise<MeResponse | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getSetupOptions(): Promise<SetupOptionsResponse>;
  getDiary(practitionerId: string, reason: DiaryReason): Promise<DiaryResponse>;
  getPatientSummary(appointmentId: string): Promise<PatientSummaryResponse>;
  confirmPatient(input: ConfirmPatientInput): Promise<SessionResponse>;
  recordConsent(sessionId: string, given: boolean, expectedVersion: number): Promise<SessionResponse>;
  cancelSession(sessionId: string, expectedVersion: number): Promise<SessionResponse>;
  getActiveSession(surgeryId: string | null, practitionerId: string): Promise<{ session: ScribeSession | null }>;
  /** Present only in demo mode. */
  readonly demo?: DemoControls;
}

export interface DemoUser {
  email: string;
  displayName: string;
  roleLabel: string;
}

export interface DemoControls {
  readonly users: readonly DemoUser[];
  signInAs(email: string): void;
  readonly scenarios: ReadonlyArray<{ id: DemoScenario; label: string }>;
  getScenario(): DemoScenario;
  setScenario(scenario: DemoScenario): void;
  auditEvents(): readonly AuditEvent[];
}
