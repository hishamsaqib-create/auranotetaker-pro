import type { AuditEvent } from '../../lib/core/audit.ts';
import type { ConfirmationMethod } from '../../lib/core/session.ts';
import type { DemoScenario } from '../../lib/dentally/mock.ts';
import type { TranscriptSegmentInput } from '../../lib/core/transcript.ts';
import type { PatientSummary } from '../../lib/dentally/types.ts';
import type {
  ActiveSessionResponse,
  ClinicSetupResponse,
  ConfirmPatientResponse,
  DentallyCheckResponse,
  DiaryResponse,
  MeResponse,
  NoteTemplatesResponse,
  NurseNoteResponse,
  PatientSummaryResponse,
  RecordingAction,
  RecordingResponse,
  SaveTranscriptResponse,
  ScribeContentResponse,
  SessionResponse,
  SetupOptionsResponse,
  SpeechTokenResponse,
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
  surgeryId: string;
  predictedAppointmentId: string | null;
  method: ConfirmationMethod;
  /** Set only after the user confirms the patient has changed their mind about an earlier decline. */
  acknowledgePreviousDecline?: boolean;
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
  confirmPatient(input: ConfirmPatientInput): Promise<ConfirmPatientResponse>;
  recordConsent(sessionId: string, given: boolean, expectedVersion: number, surgeryId: string): Promise<SessionResponse>;
  cancelSession(sessionId: string, expectedVersion: number): Promise<SessionResponse>;
  getActiveSession(surgeryId: string | null, practitionerId: string): Promise<ActiveSessionResponse>;
  /** Name and date of birth of the patient locked to a session (by the locked patient ID). */
  getSessionPatient(sessionId: string): Promise<PatientSummary>;
  /** First run only: creates the clinic and makes the app's owner its practice manager. */
  bootstrapClinic(clinicName: string): Promise<{ clinicId: string }>;
  getClinicSetup(): Promise<ClinicSetupResponse>;
  saveClinicians(clinicians: ClinicianChoice[]): Promise<ClinicSetupResponse>;
  saveSurgeries(surgeries: SurgeryChoice[]): Promise<ClinicSetupResponse>;
  saveStaffProfile(profile: StaffProfileInput): Promise<ClinicSetupResponse>;
  listNoteTemplates(includeInactive?: boolean): Promise<NoteTemplatesResponse>;
  saveNoteTemplate(t: { templateId: string | null; title: string; body: string; active: boolean }): Promise<NoteTemplatesResponse & { templateId: string }>;
  /** Audit only: a finished note was copied for Dentally. Never sends the note text. */
  recordNoteCopied(input: { sessionId: string | null; templateId: string | null; unfilledCount: number }): Promise<{ recorded: true }>;
  /** Practice manager: today's Dentally diary counted by practitioner and room ID (no patient data). */
  getDentallyCheck(): Promise<DentallyCheckResponse>;
  changeRecording(sessionId: string, surgeryId: string, action: RecordingAction, expectedVersion: number): Promise<RecordingResponse>;
  getSpeechToken(sessionId: string, surgeryId: string): Promise<SpeechTokenResponse>;
  saveTranscript(sessionId: string, surgeryId: string, segments: TranscriptSegmentInput[]): Promise<SaveTranscriptResponse>;
  getScribeContent(sessionId: string, surgeryId: string): Promise<ScribeContentResponse>;
  saveNurseNote(sessionId: string, surgeryId: string, text: string, expectedRevision: number): Promise<NurseNoteResponse>;
  /** Present only in demo mode. */
  readonly demo?: DemoControls;
}

export interface ClinicianChoice {
  practitionerId: string;
  clinicianType: 'DENTIST' | 'THERAPIST' | 'HYGIENIST' | 'OTHER';
  active: boolean;
}

/** A Dentally room (`roomId`), or a surgery named in AuraNoteTaker (`name`, with `surgeryId` once saved). */
export type SurgeryChoice = { roomId: string; active: boolean } | { surgeryId: string | null; name: string; active: boolean };

export interface StaffProfileInput {
  email: string;
  displayName: string;
  roles: string[];
  clinicianId: string | null;
  active: boolean;
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
  /** Simulates Dentally re-booking an appointment to another patient. */
  rebook(appointmentId: string, patientId: string): void;
}
