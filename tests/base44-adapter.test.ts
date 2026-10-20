// Tests for the Base44 storage adapter against an in-memory stand-in for the Base44 entity API.
// They import the generated copy in base44/shared/lib so error classes match the adapter's own.
import { describe, expect, it } from 'vitest';
import type { Base44Like } from '../base44/shared/adapters/base44.ts';
import { Base44AuditSink, Base44ClinicDirectory, Base44SessionRepository, resolveContext } from '../base44/shared/adapters/base44.ts';
import { createSession, transition } from '../base44/shared/lib/core/session.ts';
import type { ScribeSession } from '../base44/shared/lib/core/session.ts';
import { AppError } from '../base44/shared/lib/server/errors.ts';
import type { ClinicConfig } from '../base44/shared/lib/server/ports.ts';
import { VersionConflictError } from '../base44/shared/lib/server/ports.ts';

type Row = Record<string, unknown> & { id: string };
type Query = Record<string, unknown>;

function matches(row: Row, query: Query): boolean {
  return Object.entries(query).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if (Array.isArray(c.$in)) return c.$in.includes(value);
      if (typeof c.$gte === 'string') return typeof value === 'string' && value >= c.$gte;
      throw new Error(`unsupported operator in ${key}`);
    }
    return value === cond;
  });
}

/** Mimics the SDK: filter pages with { items, next_cursor, has_more }; updateMany applies to matching rows. */
class FakeEntity {
  rows: Row[] = [];
  #n = 0;
  constructor(readonly shape: 'paged' | 'array' | 'broken' = 'paged') {}

  async filter(query: Query, options: Record<string, unknown> = {}): Promise<unknown> {
    if (this.shape === 'broken') return { data: [] };
    const all = this.rows.filter((r) => matches(r, query));
    const limit = typeof options.limit === 'number' ? options.limit : 50;
    const start = typeof options.cursor === 'string' ? Number(options.cursor) : 0;
    const items = all.slice(start, start + limit).map((r) => structuredClone(r));
    if (this.shape === 'array') return items;
    const more = start + limit < all.length;
    return { items, has_more: more, next_cursor: more ? String(start + limit) : null };
  }

  async create(data: Record<string, unknown>): Promise<Row> {
    const row = { id: `row-${++this.#n}`, ...structuredClone(data) };
    this.rows.push(row);
    return structuredClone(row);
  }

  async update(id: string, data: Record<string, unknown>): Promise<Row> {
    const row = this.rows.find((r) => r.id === id)!;
    Object.assign(row, structuredClone(data));
    return structuredClone(row);
  }

  async updateMany(query: Query, data: Record<string, Record<string, unknown>>): Promise<{ updated: number }> {
    const hit = this.rows.filter((r) => matches(r, query));
    for (const r of hit) Object.assign(r, structuredClone(data.$set));
    return { updated: hit.length };
  }
}

function fakeBase44(entities: Record<string, FakeEntity>, me: Record<string, unknown> | null = null): Base44Like {
  return { auth: { me: async () => me }, asServiceRole: { entities } } as unknown as Base44Like;
}

const T = Date.parse('2026-10-20T10:40:00+01:00');
let n = 0;
function session(overrides: { surgeryId?: string | null; patientId?: string } = {}): ScribeSession {
  n += 1;
  return createSession({
    sessionId: `s-${n}`,
    clinicId: 'clinic-aura',
    clinicianId: 'PR1',
    surgeryId: overrides.surgeryId === undefined ? 'surgery-1' : overrides.surgeryId,
    patient: {
      dentallyPatientId: overrides.patientId ?? `P${n}`,
      appointment: { appointmentId: `A${n}`, practitionerId: 'PR1', roomId: null, startMs: T, finishMs: T + 1_800_000, reason: null, stateAtConfirmation: 'In surgery' },
    },
    method: 'CHOSE_FROM_DIARY',
    predictedAppointmentId: null,
    confirmedBy: 'nurse@aura.test',
    atMs: T,
  });
}

function hasNull(v: unknown): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(hasNull);
  if (v && typeof v === 'object') return Object.values(v).some(hasNull);
  return false;
}

describe('Base44 session repository', () => {
  it('stores a session without null fields and reads it back unchanged', async () => {
    const entity = new FakeEntity();
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: entity }));
    const s = session(); // room, reason, predicted appointment and consent fields are null
    await repo.create(s);
    expect(hasNull(entity.rows[0])).toBe(false);
    expect(await repo.get('clinic-aura', s.sessionId)).toEqual(s);
  });

  it('refuses an update based on a version someone else has already changed', async () => {
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: new FakeEntity() }));
    const s = session();
    await repo.create(s);
    const agreed = transition(s, { type: 'RECORD_CONSENT', given: true, by: 'nurse@aura.test', atMs: T });
    const declined = transition(s, { type: 'RECORD_CONSENT', given: false, by: 'dentist@aura.test', atMs: T });
    if (!agreed.ok || !declined.ok) throw new Error('transition refused');
    await repo.update(agreed.session, s.version);
    await expect(repo.update(declined.session, s.version)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await repo.get('clinic-aura', s.sessionId))?.consent.status).toBe('GIVEN');
  });

  it('reads every page of open sessions, so a conflict is never missed', async () => {
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: new FakeEntity() }));
    for (let i = 0; i < 450; i += 1) await repo.create(session());
    expect(await repo.findActive('clinic-aura', { surgeryId: 'surgery-1' })).toHaveLength(450);
  });

  it('treats a full page with no paging information as unreadable rather than complete', async () => {
    const entity = new FakeEntity('array');
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: entity }));
    for (let i = 0; i < 200; i += 1) await repo.create(session());
    await expect(repo.findActive('clinic-aura', { surgeryId: 'surgery-1' })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an unknown response shape instead of reading it as "no sessions"', async () => {
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: new FakeEntity('broken') }));
    await expect(repo.findActive('clinic-aura', { surgeryId: 'surgery-1' })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a malformed session row instead of filling in defaults', async () => {
    const corruptions: Array<(row: Record<string, unknown>) => void> = [
      (row) => delete row.dentally_patient_id,
      (row) => delete (row.appointment as Record<string, unknown>).state_at_confirmation,
      (row) => ((row.status_history as Record<string, unknown>[])[0]!.status = 'SOMETHING_ELSE'),
      (row) => (row.reassignments = 'not a list'),
    ];
    for (const corrupt of corruptions) {
      const entity = new FakeEntity();
      const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: entity }));
      const s = session();
      await repo.create(s);
      corrupt(entity.rows[0]!);
      await expect(repo.get('clinic-aura', s.sessionId)).rejects.toBeInstanceOf(AppError);
    }
  });

  it('accepts a row whose empty lists storage left out', async () => {
    const entity = new FakeEntity();
    const repo = new Base44SessionRepository(fakeBase44({ ScribeSession: entity }));
    const s = session();
    await repo.create(s);
    delete entity.rows[0]!.reassignments;
    expect((await repo.get('clinic-aura', s.sessionId))?.reassignments).toEqual([]);
  });
});

describe('Base44 audit sink', () => {
  it('writes no null fields and finds a recent event by its dedupe key', async () => {
    const entity = new FakeEntity();
    const sink = new Base44AuditSink(fakeBase44({ AuditEvent: entity }));
    await sink.append({
      clinicId: 'clinic-aura',
      occurredAtMs: T,
      actorEmail: 'nurse@aura.test',
      actorRoles: ['NURSE'],
      action: 'DIARY_VIEWED',
      sessionId: null,
      dentallyPatientId: null,
      dentallyAppointmentId: null,
      details: { date: '2026-10-20', practitionerId: 'PR1', appointmentCount: 3, rejectedCount: 0 },
      client: { deviceId: null, appVersion: '0.1.0' },
      dedupeKey: 'DIARY:PR1:2026-10-20',
    });
    expect(hasNull(entity.rows[0])).toBe(false);
    expect(await sink.hasRecent('clinic-aura', 'nurse@aura.test', 'DIARY:PR1:2026-10-20', T - 60_000)).toBe(true);
    expect(await sink.hasRecent('clinic-aura', 'nurse@aura.test', 'DIARY:PR1:2026-10-20', T + 60_000)).toBe(false);
    expect(await sink.hasRecent('clinic-aura', 'other@aura.test', 'DIARY:PR1:2026-10-20', T - 60_000)).toBe(false);
  });
});

describe('Base44 caller and directory', () => {
  const clinic: ClinicConfig = {
    clinicId: 'clinic-aura',
    name: 'Aura Dental Clinic',
    timeZone: 'Europe/London',
    dentallySiteId: null,
    settings: { earlyStartMinutes: 10, overrunMinutes: 30 },
  };

  it('takes roles from the StaffProfile, never from the user record, and drops unknown roles', async () => {
    const profiles = new FakeEntity();
    await profiles.create({ user_email: 'nurse@aura.test', clinic_id: 'clinic-aura', active: true, app_roles: ['NURSE', 'MADE_UP'], display_name: 'Hannah' });
    // The user record claims SUPER_ADMIN; users can edit their own record, so it is ignored.
    const base44 = fakeBase44({ StaffProfile: profiles }, { email: 'Nurse@Aura.test', app_roles: ['SUPER_ADMIN'] });
    const ctx = await resolveContext(base44, clinic, new Headers({ 'x-device-id': 'device-1' }));
    expect(ctx).toMatchObject({ email: 'nurse@aura.test', roles: ['NURSE'], deviceId: 'device-1', clinicId: 'clinic-aura' });
  });

  it('ignores a device ID header that is not a plain identifier', async () => {
    const profiles = new FakeEntity();
    await profiles.create({ user_email: 'nurse@aura.test', clinic_id: 'clinic-aura', active: true, app_roles: ['NURSE'] });
    const base44 = fakeBase44({ StaffProfile: profiles }, { email: 'nurse@aura.test' });
    const ctx = await resolveContext(base44, clinic, new Headers({ 'x-device-id': 'Oliver Bennett 12/03/1986' }));
    expect(ctx.deviceId).toBeNull();
  });

  it('refuses a signed-in user with no active profile in this clinic', async () => {
    const base44 = fakeBase44({ StaffProfile: new FakeEntity() }, { email: 'stranger@example.test' });
    await expect(resolveContext(base44, clinic, new Headers())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a clinician row with no practitioner ID rather than showing "undefined"', async () => {
    const clinicians = new FakeEntity();
    await clinicians.create({ clinic_id: 'clinic-aura', active: true, display_name: 'Dr Sarah Lin' });
    const directory = new Base44ClinicDirectory(fakeBase44({ Clinician: clinicians }));
    await expect(directory.listClinicians('clinic-aura')).rejects.toBeInstanceOf(AppError);
  });
});
