// In-memory implementations of the server ports, for demo mode and tests.
// Nothing here is persisted; closing the tab clears it.

import type { AuditEvent } from '../core/audit.ts';
import type { NoteTemplate } from '../core/noteTemplates.ts';
import type { ScribeSession } from '../core/session.ts';
import { isTerminal } from '../core/session.ts';
import type {
  AuditSink,
  ClinicAdminStore,
  ClinicDirectory,
  ClinicianEntry,
  ClinicianRecord,
  ScribeContentStore,
  SessionRepository,
  SpeechToken,
  SpeechTokenIssuer,
  StoredNurseNote,
  StoredSegment,
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

  async saveSurgeryRecords(clinicId: string, records: readonly (Omit<SurgeryRecord, 'surgeryId'> & { surgeryId?: string | null })[]): Promise<void> {
    if (clinicId !== this.#clinicId) throw new Error('Unknown clinic');
    for (const r of records) {
      const i = r.surgeryId
        ? this.#surgeries.findIndex((s) => s.surgeryId === r.surgeryId)
        : this.#surgeries.findIndex((s) => s.roomId !== null && s.roomId === r.roomId);
      if (i >= 0) this.#surgeries[i] = { ...this.#surgeries[i]!, name: r.name, active: r.active };
      else this.#surgeries.push({ surgeryId: `SURGERY-${this.#nextSurgery++}`, name: r.name, roomId: r.roomId, active: r.active });
    }
  }

  readonly #templates: NoteTemplate[] = [];
  #nextTemplate = 1;

  async listNoteTemplates(clinicId: string): Promise<NoteTemplate[]> {
    return clinicId === this.#clinicId ? this.#templates.map((t) => ({ ...t })) : [];
  }

  async saveNoteTemplate(
    clinicId: string,
    t: { templateId: string | null; title: string; body: string; active: boolean; updatedBy: string; updatedAtMs: number },
  ): Promise<string> {
    if (clinicId !== this.#clinicId) throw new Error('Unknown clinic');
    const fields = { title: t.title, body: t.body, active: t.active, updatedBy: t.updatedBy, updatedAtMs: t.updatedAtMs, starter: false };
    if (t.templateId) {
      const i = this.#templates.findIndex((x) => x.templateId === t.templateId);
      if (i < 0) throw new Error('Unknown template');
      this.#templates[i] = { ...this.#templates[i]!, ...fields };
      return t.templateId;
    }
    const templateId = `TEMPLATE-${this.#nextTemplate++}`;
    this.#templates.push({ templateId, ...fields });
    return templateId;
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

export class InMemoryScribeContentStore implements ScribeContentStore {
  readonly #segments = new Map<string, StoredSegment[]>();
  readonly #notes = new Map<string, StoredNurseNote>();

  #key(clinicId: string, sessionId: string): string {
    return `${clinicId}/${sessionId}`;
  }

  async listSegments(clinicId: string, sessionId: string): Promise<StoredSegment[]> {
    return structuredClone(this.#segments.get(this.#key(clinicId, sessionId)) ?? []);
  }

  async addSegments(clinicId: string, sessionId: string, segments: readonly StoredSegment[]): Promise<number> {
    const key = this.#key(clinicId, sessionId);
    const list = this.#segments.get(key) ?? [];
    const ids = new Set(list.map((s) => s.segmentId));
    let added = 0;
    for (const s of segments) {
      if (ids.has(s.segmentId)) continue;
      ids.add(s.segmentId);
      list.push(structuredClone(s));
      added += 1;
    }
    this.#segments.set(key, list);
    return added;
  }

  async getNurseNote(clinicId: string, sessionId: string): Promise<StoredNurseNote | null> {
    const note = this.#notes.get(this.#key(clinicId, sessionId));
    return note ? structuredClone(note) : null;
  }

  async saveNurseNote(clinicId: string, sessionId: string, note: StoredNurseNote, expectedRevision: number): Promise<void> {
    const key = this.#key(clinicId, sessionId);
    if ((this.#notes.get(key)?.revision ?? 0) !== expectedRevision) throw new VersionConflictError();
    this.#notes.set(key, structuredClone(note));
  }

  async deleteSession(clinicId: string, sessionId: string): Promise<number> {
    const key = this.#key(clinicId, sessionId);
    const removed = (this.#segments.get(key)?.length ?? 0) + (this.#notes.has(key) ? 1 : 0);
    this.#segments.delete(key);
    this.#notes.delete(key);
    return removed;
  }

  async purgeExpired(clinicId: string, nowMs: number, limit: number): Promise<number> {
    let removed = 0;
    for (const [key, list] of this.#segments) {
      if (!key.startsWith(`${clinicId}/`)) continue;
      const keep: StoredSegment[] = [];
      for (const s of list) {
        if (s.deleteAfterMs <= nowMs && removed < limit) removed += 1;
        else keep.push(s);
      }
      this.#segments.set(key, keep);
    }
    for (const [key, note] of this.#notes) {
      if (key.startsWith(`${clinicId}/`) && note.deleteAfterMs <= nowMs && removed < limit) {
        this.#notes.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Demo mode: no speech service; the scribe screen plays a scripted transcript instead. */
export class DemoSpeechTokenIssuer implements SpeechTokenIssuer {
  readonly provider = 'DEMO' as const;
  constructor(private readonly clock: () => number) {}
  async issue(): Promise<SpeechToken> {
    return { provider: 'DEMO', url: null, expiresAtMs: this.clock() + 60_000 };
  }
}
