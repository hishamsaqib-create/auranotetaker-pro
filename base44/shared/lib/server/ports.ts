// GENERATED from lib/server/ports.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Interfaces the server handlers depend on. Implemented in memory (demo mode, tests)
// and on Base44 entities (base44/shared/adapters). Keeping them small keeps the
// hosting decision (docs/architecture.md section 8) reversible.

import type { AuditEvent } from '../core/audit.ts';
import type { ScribeSession } from '../core/session.ts';
import type { DentallyReadService } from '../dentally/types.ts';

export type AppRole = 'SUPER_ADMIN' | 'CLINIC_ADMIN' | 'DENTIST' | 'THERAPIST' | 'HYGIENIST' | 'NURSE' | 'AUDITOR';

export const APP_ROLES: readonly AppRole[] = ['SUPER_ADMIN', 'CLINIC_ADMIN', 'DENTIST', 'THERAPIST', 'HYGIENIST', 'NURSE', 'AUDITOR'];

/** Who is calling. Resolved server-side from the authenticated user and their StaffProfile, never from request input. */
export interface StaffContext {
  email: string;
  displayName: string;
  clinicId: string;
  roles: AppRole[];
  /** Dentally practitioner ID when this person is a clinician. */
  clinicianId: string | null;
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

/** Configured clinicians and surgeries for a clinic (from the Clinician and Surgery entities). */
export interface ClinicDirectory {
  listClinicians(clinicId: string): Promise<ClinicianEntry[]>;
  listSurgeries(clinicId: string): Promise<SurgeryEntry[]>;
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
  /** Non-terminal sessions in the clinic matching any of the given filters. */
  findActive(clinicId: string, filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null }): Promise<ScribeSession[]>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface HandlerDeps {
  clock: () => number;
  newId: () => string;
  clinic: ClinicConfig;
  dentally: DentallyReadService;
  sessions: SessionRepository;
  audit: AuditSink;
  directory: ClinicDirectory;
}
