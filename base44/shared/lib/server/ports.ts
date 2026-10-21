// GENERATED from lib/server/ports.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Interfaces the server handlers depend on. Implemented in memory (demo mode, tests)
// and on Base44 entities (base44/shared/adapters). Keeping them small keeps the
// hosting decision (docs/architecture.md section 8) reversible.

import type { AuditEvent } from '../core/audit.ts';
import type { NoteTemplate } from '../core/noteTemplates.ts';
import type { NoteMark } from '../core/notesToDo.ts';
import type { ScribeSession } from '../core/session.ts';
import type { DentallyReadService } from '../dentally/types.ts';
import type { ContentCipher } from './cipher.ts';

export type AppRole = 'SUPER_ADMIN' | 'CLINIC_ADMIN' | 'DENTIST' | 'THERAPIST' | 'HYGIENIST' | 'NURSE' | 'AUDITOR';

export const APP_ROLES: readonly AppRole[] = ['SUPER_ADMIN', 'CLINIC_ADMIN', 'DENTIST', 'THERAPIST', 'HYGIENIST', 'NURSE', 'AUDITOR'];

/** Who is calling. Resolved server-side from the authenticated user and their StaffProfile, never from request input. */
export interface StaffContext {
  email: string;
  displayName: string;
  clinicId: string;
  roles: AppRole[];
  /** Dentally practitioner ID of a clinician's own diary. Grants access to that clinician's sessions. */
  clinicianId: string | null;
  /** For a nurse, the dentist they usually work with: only preselects a new computer, grants no access. */
  worksWithClinicianId?: string | null;
  /** The surgery this person usually works in, to preselect on a new computer. */
  defaultSurgeryId?: string | null;
  deviceId?: string | null;
  appVersion?: string | null;
}

export interface ClinicConfig {
  clinicId: string;
  name: string;
  timeZone: string;
  dentallySiteId: string | null;
  settings: {
    earlyStartMinutes: number;
    overrunMinutes: number;
  };
}

export interface ClinicianEntry {
  practitionerId: string;
  displayName: string;
  clinicianType: 'DENTIST' | 'THERAPIST' | 'HYGIENIST' | 'OTHER';
}

export interface SurgeryEntry {
  surgeryId: string;
  name: string;
  roomId: string | null;
}

/** Configured clinicians and surgeries for a clinic (from the Clinician and Surgery entities). Active ones only. */
export interface ClinicDirectory {
  listClinicians(clinicId: string): Promise<ClinicianEntry[]>;
  listSurgeries(clinicId: string): Promise<SurgeryEntry[]>;
}

export interface ClinicianRecord extends ClinicianEntry {
  /** The Dentally user linked to the practitioner (Aura integrations have used it; issue P1-03). */
  dentallyUserId: string | null;
  active: boolean;
}

export interface SurgeryRecord extends SurgeryEntry {
  active: boolean;
}

export interface StaffProfileRecord {
  /** Lower case. Matches the Base44 sign-in email. */
  email: string;
  displayName: string;
  roles: AppRole[];
  /** Dentally practitioner ID of a clinician's own diary. Grants access to that clinician's sessions. */
  clinicianId: string | null;
  /** For a nurse, the dentist they usually work with: preselects a new computer only. */
  worksWithClinicianId?: string | null;
  /** The surgery this person usually works in. */
  defaultSurgeryId?: string | null;
  active: boolean;
}

/** Sends a Base44 invitation to the AuraNoteTaker app. */
export interface StaffInviter {
  invite(email: string): Promise<void>;
}

/** Configuration reads and writes for the setup screens. Only CLINIC_ADMIN handlers use it. */
export interface ClinicAdminStore {
  /** All clinicians, active or not. */
  listClinicianRecords(clinicId: string): Promise<ClinicianRecord[]>;
  /** Creates or updates each record, matched by Dentally practitioner ID. */
  saveClinicianRecords(clinicId: string, records: readonly ClinicianRecord[]): Promise<void>;
  /** All surgeries, active or not. */
  listSurgeryRecords(clinicId: string): Promise<SurgeryRecord[]>;
  /**
   * Creates or updates each surgery: matched by `surgeryId` when given, otherwise by Dentally room ID; a record
   * with neither is created (a surgery named by the practice manager, for when Dentally lists no rooms).
   */
  saveSurgeryRecords(clinicId: string, records: readonly (Omit<SurgeryRecord, 'surgeryId'> & { surgeryId?: string | null })[]): Promise<void>;
  listStaff(clinicId: string): Promise<StaffProfileRecord[]>;
  /** Creates or updates the profile, matched by email. */
  saveStaff(clinicId: string, record: StaffProfileRecord): Promise<void>;
  /** The clinic's own note templates (not the starters), active or not. */
  listNoteTemplates(clinicId: string): Promise<NoteTemplate[]>;
  /** Creates (templateId null) or updates a template. Returns its ID. */
  saveNoteTemplate(
    clinicId: string,
    t: { templateId: string | null; title: string; body: string; active: boolean; updatedBy: string; updatedAtMs: number },
  ): Promise<string>;
}

export class VersionConflictError extends Error {
  constructor() {
    super('The session was changed elsewhere');
    this.name = 'VersionConflictError';
  }
}

export interface SessionRepository {
  create(session: ScribeSession): Promise<void>;
  get(clinicId: string, sessionId: string): Promise<ScribeSession | null>;
  /** Must throw VersionConflictError when the stored version is not `expectedVersion`. */
  update(session: ScribeSession, expectedVersion: number): Promise<void>;
  /** Non-terminal sessions in the clinic matching any of the given filters. Must return all of them, never a truncated page. */
  findActive(clinicId: string, filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null }): Promise<ScribeSession[]>;
  /** Sessions in any status for the given Dentally appointments. */
  findByAppointments(clinicId: string, appointmentIds: readonly string[]): Promise<ScribeSession[]>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
  /** Whether this actor recorded an event with this dedupe key since `sinceMs`. */
  hasRecent(clinicId: string, actorEmail: string, dedupeKey: string, sinceMs: number): Promise<boolean>;
}

/** A transcript segment as stored: the text is encrypted (see cipher.ts), everything else is plain. */
export interface StoredSegment {
  kind: 'SPEECH' | 'GAP';
  segmentId: string;
  seq: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  cipherText: string;
  capturedBy: string;
  savedAtMs: number;
  deleteAfterMs: number;
}

export interface StoredNurseNote {
  cipherText: string;
  revision: number;
  updatedBy: string;
  updatedAtMs: number;
  deleteAfterMs: number;
}

/**
 * Short-lived clinical content (transcripts and nurse notes) while a session is worked on. Held only
 * until the end of the next day (decision D2a), encrypted.
 */
export interface ScribeContentStore {
  listSegments(clinicId: string, sessionId: string): Promise<StoredSegment[]>;
  /** Stores each segment whose ID is not already stored for the session; the rest are skipped. Returns how many were new. */
  addSegments(clinicId: string, sessionId: string, segments: readonly StoredSegment[]): Promise<number>;
  getNurseNote(clinicId: string, sessionId: string): Promise<StoredNurseNote | null>;
  /** Must throw VersionConflictError unless the stored revision is `expectedRevision` (0 = none stored yet). */
  saveNurseNote(clinicId: string, sessionId: string, note: StoredNurseNote, expectedRevision: number): Promise<void>;
  /** Deletes all of a session's content. Returns how many records were removed. */
  deleteSession(clinicId: string, sessionId: string): Promise<number>;
  /** Deletes content past its delete-after time, at most `limit` records per call. Returns how many were removed. */
  purgeExpired(clinicId: string, nowMs: number, limit: number): Promise<number>;
}

export type SpeechProvider = 'SPEECHMATICS' | 'DEMO';

/** What the scribe screen needs to stream audio to speech-to-text. The token lasts about a minute. */
export interface SpeechToken {
  provider: SpeechProvider;
  /** WebSocket address including the short-lived token, or null in demo mode. */
  url: string | null;
  expiresAtMs: number;
}

export interface SpeechTokenIssuer {
  readonly provider: SpeechProvider;
  issue(): Promise<SpeechToken>;
}

export class SpeechServiceError extends Error {
  constructor(readonly kind: 'NOT_CONFIGURED' | 'AUTH' | 'UNAVAILABLE') {
    super(`Speech-to-text ${kind}`);
    this.name = 'SpeechServiceError';
  }
}

export interface HandlerDeps {
  clock: () => number;
  newId: () => string;
  clinic: ClinicConfig;
  dentally: DentallyReadService;
  sessions: SessionRepository;
  audit: AuditSink;
  directory: ClinicDirectory;
  admin: ClinicAdminStore;
  content: ScribeContentStore;
  /** Created on first use, so a missing encryption key only affects scribe content, not the diary. */
  cipher: () => Promise<ContentCipher>;
  speech: SpeechTokenIssuer;
  invites: StaffInviter;
  notes: NoteGenerator;
  noteMarks: NoteMarkStore;
}

/**
 * Which appointments have had their note done: copied from AuraNoteTaker, or ticked off as written in Dentally.
 * Identifiers, dates and staff emails only: never note text, never patient names.
 */
export interface NoteMarkStore {
  listByDate(clinicId: string, date: string): Promise<NoteMark[]>;
  get(clinicId: string, appointmentId: string): Promise<NoteMark | null>;
  /** Creates or replaces the mark for the appointment. */
  save(clinicId: string, mark: NoteMark): Promise<void>;
  /** Removes the mark for the appointment. Returns whether there was one. */
  remove(clinicId: string, appointmentId: string): Promise<boolean>;
}

/** A large language model that drafts a clinical note. Text in, text out; never stores anything itself. */
export interface NoteGenerator {
  readonly provider: 'ANTHROPIC' | 'DEMO';
  generate(input: { system: string; prompt: string; maxTokens: number }): Promise<{ text: string; model: string }>;
}

export class NoteGeneratorError extends Error {
  constructor(readonly kind: 'NOT_CONFIGURED' | 'AUTH' | 'UNAVAILABLE' | 'REFUSED' | 'INCOMPLETE') {
    super(`Note generator ${kind}`);
    this.name = 'NoteGeneratorError';
  }
}
