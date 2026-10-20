// GENERATED from lib/server/memory.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// In-memory implementations of the server ports, for demo mode and tests.
// Nothing here is persisted; closing the tab clears it.

import type { AuditEvent } from '../core/audit.ts';
import type { ScribeSession } from '../core/session.ts';
import { isTerminal } from '../core/session.ts';
import type {
  AuditSink,
  ClinicAdminStore,
  ClinicDirectory,
  ClinicianEntry,
  ClinicianRecord,
  SessionRepository,
  StaffProfileRecord,
  SurgeryEntry,
  SurgeryRecord,
} from './ports.ts';
import { VersionConflictError } from './ports.ts';

export class InMemorySessionRepository implements SessionRepository {
  readonly #rows = new Map<string, ScribeSession>();

  async create(session: ScribeSession): Promise<void> {
    if (this.#rows.has(session.sessionId)) throw new Error('Session ID already exists');
    this.#rows.set(session.sessionId, structuredClone(session));
  }

  async get(clinicId: string, sessionId: string): Promise<ScribeSession | null> {
    const row = this.#rows.get(sessionId);
    return row && row.clinicId === clinicId ? structuredClone(row) : null;
  }

  async update(session: ScribeSession, expectedVersion: number): Promise<void> {
    const row = this.#rows.get(session.sessionId);
    if (!row || row.version !== expectedVersion) throw new VersionConflictError();
    this.#rows.set(session.sessionId, structuredClone(session));
  }

  async findActive(
    clinicId: string,
    filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null },
  ): Promise<ScribeSession[]> {
    return [...this.#rows.values()]
      .filter((s) => s.clinicId === clinicId && !isTerminal(s.status))
      .filter(
        (s) =>
          (filter.surgeryId != null && s.surgeryId === filter.surgeryId) ||
          (filter.clinicianId != null && s.clinicianId === filter.clinicianId) ||
          (filter.patientId != null && s.patient.dentallyPatientId === filter.patientId),
      )
      .map((s) => structuredClone(s));
  }

  async findByAppointments(clinicId: string, appointmentIds: readonly string[]): Promise<ScribeSession[]> {
    const wanted = new Set(appointmentIds);
    return [...this.#rows.values()]
      .filter((s) => s.clinicId === clinicId && wanted.has(s.patient.appointment.appointmentId))
      .map((s) => structuredClone(s));
  }

  /** Test and demo helper. */
  all(): ScribeSession[] {
    return [...this.#rows.values()].map((s) => structuredClone(s));
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(Object.freeze(structuredClone(event)));
  }

  async hasRecent(clinicId: string, actorEmail: string, dedupeKey: string, sinceMs: number): Promise<boolean> {
    return this.events.some(
      (e) => e.clinicId === clinicId && e.actorEmail === actorEmail && e.dedupeKey === dedupeKey && e.occurredAtMs >= sinceMs,
    );
  }
}

/**
 * Clinic configuration held in memory (demo mode and tests): the directory the clinical handlers read,
 * and the store the setup handlers write.
 */
export class StaticClinicDirectory implements ClinicDirectory, ClinicAdminStore {
  readonly #clinicId: string;
  #clinicians: ClinicianRecord[];
  #surgeries: SurgeryRecord[];
  #staff: StaffProfileRecord[];
  #nextSurgery = 1;

  constructor(clinicId: string, clinicians: ClinicianEntry[], surgeries: SurgeryEntry[], staff: StaffProfileRecord[] = []) {
    this.#clinicId = clinicId;
    this.#clinicians = clinicians.map((c) => ({ ...c, dentallyUserId: null, active: true }));
    this.#surgeries = surgeries.map((s) => ({ ...s, active: true }));
    this.#staff = staff.map((x) => structuredClone(x));
  }

  async listClinicians(clinicId: string): Promise<ClinicianEntry[]> {
    if (clinicId !== this.#clinicId) return [];
    return this.#clinicians.filter((c) => c.active).map(({ practitionerId, displayName, clinicianType }) => ({ practitionerId, displayName, clinicianType }));
  }

  async listSurgeries(clinicId: string): Promise<SurgeryEntry[]> {
    if (clinicId !== this.#clinicId) return [];
    return this.#surgeries.filter((s) => s.active).map(({ surgeryId, name, roomId }) => ({ surgeryId, name, roomId }));
  }

  async listClinicianRecords(clinicId: string): Promise<ClinicianRecord[]> {
    return clinicId === this.#clinicId ? this.#clinicians.map((c) => ({ ...c })) : [];
  }

  async saveClinicianRecords(clinicId: string, records: readonly ClinicianRecord[]): Promise<void> {
    if (clinicId !== this.#clinicId) throw new Error('Unknown clinic');
    for (const r of records) {
      const i = this.#clinicians.findIndex((c) => c.practitionerId === r.practitionerId);
      if (i >= 0) this.#clinicians[i] = { ...r };
      else this.#clinicians.push({ ...r });
    }
  }

  async listSurgeryRecords(clinicId: string): Promise<SurgeryRecord[]> {
    return clinicId === this.#clinicId ? this.#surgeries.map((s) => ({ ...s })) : [];
  }

  async saveSurgeryRecords(clinicId: string, records: readonly Omit<SurgeryRecord, 'surgeryId'>[]): Promise<void> {
    if (clinicId !== this.#clinicId) throw new Error('Unknown clinic');
    for (const r of records) {
      const i = this.#surgeries.findIndex((s) => s.roomId !== null && s.roomId === r.roomId);
      if (i >= 0) this.#surgeries[i] = { ...this.#surgeries[i]!, name: r.name, active: r.active };
      else this.#surgeries.push({ surgeryId: `SURGERY-${this.#nextSurgery++}`, name: r.name, roomId: r.roomId, active: r.active });
    }
  }

  async listStaff(clinicId: string): Promise<StaffProfileRecord[]> {
    return clinicId === this.#clinicId ? this.#staff.map((x) => structuredClone(x)) : [];
  }

  async saveStaff(clinicId: string, record: StaffProfileRecord): Promise<void> {
    if (clinicId !== this.#clinicId) throw new Error('Unknown clinic');
    const i = this.#staff.findIndex((x) => x.email === record.email);
    if (i >= 0) this.#staff[i] = structuredClone(record);
    else this.#staff.push(structuredClone(record));
  }
}
