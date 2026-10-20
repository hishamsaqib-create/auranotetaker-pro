// Types shared by the Dentally client, parser, live service and mock service.

import type { DiaryAppointment } from '../core/appointments.ts';

export interface PatientSummary {
  patientId: string;
  /** "Oliver Bennett". Display only; never persisted by AuraNoteTaker. */
  displayName: string;
  /** YYYY-MM-DD, or null if Dentally did not provide a valid date. */
  dateOfBirth: string | null;
}

export interface PractitionerSummary {
  /** The practitioner's own ID. */
  practitionerId: string;
  /** The linked Dentally user ID (AuraPortal uses this as the practitioner identifier; see issue P1-03). */
  userId: string | null;
  displayName: string;
  active: boolean;
}

export interface RoomSummary {
  roomId: string;
  name: string;
  siteId: string | null;
}

export interface RoomListReport {
  rooms: RoomSummary[];
  /** How many rooms Dentally returned, before checking. */
  returned: number;
  /** Why rooms were dropped, by reason code. */
  rejected: Record<string, number>;
  /** Whether rooms had to be fetched site by site because the plain list was empty. */
  bySite: boolean;
  /** Field names (never values) on the first room Dentally returned, to fix the mapping if it differs. */
  fieldNames: string[];
}

export interface DiaryResult {
  appointments: DiaryAppointment[];
  /** Records Dentally returned that failed validation and were dropped rather than guessed at. */
  rejectedCount: number;
}

export interface DentallyCapabilities {
  readDiary: boolean;
  readPatients: boolean;
  readClinicalHistory: boolean;
  readClinicalNotes: boolean;
  writeClinicalNotes: boolean;
}

export interface UnsupportedResult {
  supported: false;
  reason: 'NOT_AVAILABLE_IN_DENTALLY_API';
  detail: string;
}

/**
 * Everything AuraNoteTaker may ask of Dentally. Read-only by design: there is no method
 * that changes Dentally data. The three clinical-record operations exist so callers get
 * an explicit "not supported" answer instead of a workaround.
 */
export interface DentallyReadService {
  readonly mode: 'live' | 'mock';
  capabilities(): DentallyCapabilities;
  getTodaysAppointments(params: { date: string; siteId?: string | null }): Promise<DiaryResult>;
  getClinicianAppointments(params: { date: string; practitionerId: string; siteId?: string | null }): Promise<DiaryResult>;
  /** Null when Dentally has no such appointment. */
  getAppointment(appointmentId: string): Promise<DiaryAppointment | null>;
  /** Null when Dentally has no such patient. */
  getPatient(patientId: string): Promise<PatientSummary | null>;
  listPractitioners(): Promise<PractitionerSummary[]>;
  listRooms(): Promise<RoomSummary[]>;
  /** Rooms plus what was dropped and why, for the setup screen when no rooms can be read. No patient data. */
  listRoomsWithReport(): Promise<RoomListReport>;
  ping(): Promise<{ latencyMs: number }>;
  getPatientClinicalHistory(patientId: string): Promise<UnsupportedResult>;
  getPatientNotes(patientId: string): Promise<UnsupportedResult>;
  createClinicalNote(input: unknown): Promise<UnsupportedResult>;
}
