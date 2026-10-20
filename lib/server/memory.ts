// In-memory implementations of the server ports, for demo mode and tests.
// Nothing here is persisted; closing the tab clears it.

import type { AuditEvent } from '../core/audit.ts';
import type { ScribeSession } from '../core/session.ts';
import { isTerminal } from '../core/session.ts';
import type { AuditSink, ClinicDirectory, ClinicianEntry, SessionRepository, SurgeryEntry } from './ports.ts';
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
}

export class StaticClinicDirectory implements ClinicDirectory {
  readonly #clinicId: string;
  readonly #clinicians: ClinicianEntry[];
  readonly #surgeries: SurgeryEntry[];

  constructor(clinicId: string, clinicians: ClinicianEntry[], surgeries: SurgeryEntry[]) {
    this.#clinicId = clinicId;
    this.#clinicians = clinicians;
    this.#surgeries = surgeries;
  }

  async listClinicians(clinicId: string): Promise<ClinicianEntry[]> {
    return clinicId === this.#clinicId ? this.#clinicians.map((c) => ({ ...c })) : [];
  }

  async listSurgeries(clinicId: string): Promise<SurgeryEntry[]> {
    return clinicId === this.#clinicId ? this.#surgeries.map((s) => ({ ...s })) : [];
  }
}
