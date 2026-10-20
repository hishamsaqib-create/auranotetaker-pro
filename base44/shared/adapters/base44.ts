// Base44 adapters: resolve the caller and build handler dependencies inside a Base44 backend function.
//
// NOT YET VERIFIED against a live Base44 app (issue P1-01). Per Base44's backend-function docs, each
// function default-exports a request handler, and secrets come from `secrets.get()` in the built-in
// `base44:runtime` module, read inside the handler (they resolve per request). Entry points pass that
// reader in, so this file stays testable outside Base44. Assumptions still to confirm:
//   - createClientFromRequest(req).asServiceRole.entities.<Name> bypasses entity access rules (per SDK 0.8 docs)
//   - filter(query, { limit, cursor }) returns { items, next_cursor, has_more } and supports $in/$gte (SDK 0.8 types)
//   - updateMany(query, { $set }) applies atomically to the rows matching the query, so filtering on `version`
//     gives compare-and-set
//   - a row is visible to every later filter once create() has returned (the simultaneous-confirmation
//     check in confirmPatient relies on this)
//
// SAFETY: anything unexpected from the database (an unknown response shape, a malformed session row,
// more rows than can be read) throws. Nothing is assumed or filled in with defaults.
//
// SECURITY: roles and clinic membership come from the StaffProfile entity, which only functions can write.
// They are never read from the Base44 user record, because users can edit their own custom user fields.

import type { AuditEvent } from '../lib/core/audit.ts';
import type { ScribeSession } from '../lib/core/session.ts';
import { KNOWN_APPOINTMENT_STATES } from '../lib/core/appointments.ts';
import { isTerminal } from '../lib/core/session.ts';
import { DentallyClient } from '../lib/dentally/client.ts';
import { createLiveDentallyService } from '../lib/dentally/service.ts';
import type { BootstrapCaller, ClinicRegistry, ClinicRow } from '../lib/server/bootstrap.ts';
import { bootstrapClinic } from '../lib/server/bootstrap.ts';
import { AesGcmContentCipher } from '../lib/server/cipher.ts';
import type { ContentCipher } from '../lib/server/cipher.ts';
import { AppError } from '../lib/server/errors.ts';
import { SPEECHMATICS_RT_URL, SPEECHMATICS_TEMP_KEY_TTL_SECONDS, SPEECHMATICS_TEMP_KEY_URL } from '../lib/speech/speechmatics.ts';
import type {
  AppRole,
  AuditSink,
  ClinicAdminStore,
  ClinicConfig,
  ClinicDirectory,
  ClinicianEntry,
  ClinicianRecord,
  HandlerDeps,
  ScribeContentStore,
  SessionRepository,
  SpeechToken,
  SpeechTokenIssuer,
  StoredNurseNote,
  StoredSegment,
  StaffContext,
  StaffProfileRecord,
  SurgeryEntry,
  SurgeryRecord,
} from '../lib/server/ports.ts';
import { APP_ROLES, SpeechServiceError, VersionConflictError } from '../lib/server/ports.ts';

// Minimal structural types so this file does not depend on SDK type definitions.
type Row = Record<string, unknown> & { id?: string };
interface EntityApi {
  filter(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  create(data: Record<string, unknown>): Promise<Row>;
  update(id: string, data: Record<string, unknown>): Promise<Row>;
  updateMany(query: Record<string, unknown>, data: Record<string, Record<string, unknown>>): Promise<{ updated?: number } | null>;
  delete(id: string): Promise<unknown>;
  deleteMany(query: Record<string, unknown>): Promise<unknown>;
}
export interface Base44Like {
  auth: { me(): Promise<{ email?: string | null; full_name?: string | null; role?: string | null } | null> };
  asServiceRole: { entities: Record<string, EntityApi> };
}

/** Reads a secret for the current request (Base44: `secrets.get` from `base44:runtime`). */
export type SecretReader = (name: string) => string | undefined;

const APP_VERSION = '0.1.0';

const UNREADABLE = 'The database returned something AuraNoteTaker could not read. Please tell the practice manager.';

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { items?: unknown }).items)) {
    return (result as { items: Row[] }).items;
  }
  throw new AppError('INTERNAL', UNREADABLE);
}

const PAGE = 200;
const MAX_PAGES = 50;

/** Every row matching the query, across pages. Throws rather than return a list that might be incomplete. */
async function allRows(entity: EntityApi, query: Record<string, unknown>): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await entity.filter(query, { limit: PAGE, sort: '-created_date', ...(cursor ? { cursor } : {}) });
    if (Array.isArray(page)) {
      // Older SDK shape with no paging information: only trustworthy if it is clearly not full.
      if (page.length >= PAGE) throw new AppError('INTERNAL', UNREADABLE);
      return [...out, ...(page as Row[])];
    }
    out.push(...rows(page));
    const p = page as { next_cursor?: string | null; has_more?: boolean };
    if (!p.has_more || !p.next_cursor) return out;
    cursor = p.next_cursor;
  }
  throw new AppError('INTERNAL', UNREADABLE);
}

/** Drops null and undefined object fields (schemas declare plain types; absent means null). */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = compact(v);
    return out as T;
  }
  return value;
}

function requireSecret(readSecret: SecretReader, name: string): string {
  const value = readSecret(name);
  if (!value) throw new AppError('INTERNAL', 'AuraNoteTaker is not fully configured. Please tell the practice manager.');
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isoToMs = (v: unknown): number | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const msToIso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

// ---------------------------------------------------------------------------
// Caller and clinic

export async function resolveClinic(base44: Base44Like, readSecret: SecretReader): Promise<ClinicConfig> {
  const clinicKey = requireSecret(readSecret, 'CLINIC_KEY');
  const clinic = rows(await base44.asServiceRole.entities.Clinic!.filter({ slug: clinicKey, status: 'ACTIVE' }, { limit: 1 }))[0];
  if (!clinic?.id) throw new AppError('NOT_SET_UP', 'AuraNoteTaker has not been set up yet.');
  const settings = (clinic.settings ?? {}) as Record<string, unknown>;
  return {
    clinicId: clinic.id,
    name: str(clinic.name) ?? 'Clinic',
    timeZone: str(clinic.time_zone) ?? 'Europe/London',
    dentallySiteId: str(clinic.dentally_site_id),
    settings: {
      earlyStartMinutes: typeof settings.early_start_minutes === 'number' ? settings.early_start_minutes : 10,
      overrunMinutes: typeof settings.overrun_minutes === 'number' ? settings.overrun_minutes : 30,
    },
  };
}

export async function resolveContext(base44: Base44Like, clinic: ClinicConfig, headers: Headers): Promise<StaffContext> {
  const me = await base44.auth.me().catch(() => null);
  const email = str(me?.email)?.toLowerCase();
  if (!email) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
  const profile = rows(
    await base44.asServiceRole.entities.StaffProfile!.filter({ user_email: email, clinic_id: clinic.clinicId, active: true }, { limit: 1 }),
  )[0];
  if (!profile) throw new AppError('FORBIDDEN', 'Your account is not set up for AuraNoteTaker. Please ask the practice manager.');
  const roles = (Array.isArray(profile.app_roles) ? profile.app_roles : []).filter((r): r is AppRole =>
    (APP_ROLES as readonly unknown[]).includes(r),
  );
  return {
    email,
    displayName: str(profile.display_name) ?? str(me?.full_name) ?? email,
    clinicId: clinic.clinicId,
    roles,
    clinicianId: str(profile.clinician_id),
    // A random per-browser ID. Anything else in the header is ignored rather than stored.
    deviceId: ((v) => (v && DEVICE_ID.test(v) ? v : null))(headers.get('x-device-id')),
    appVersion: APP_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Repositories on Base44 entities (service role; entity rules deny direct client access)

const SESSION_STATUSES = new Set([
  'PATIENT_CONFIRMED', 'CONSENT_DECLINED', 'READY', 'RECORDING', 'PAUSED', 'STOPPED', 'GENERATING', 'IN_REVIEW', 'APPROVED', 'DISCARDED', 'CANCELLED',
]);
const ACTIVE_STATUSES = ['PATIENT_CONFIRMED', 'READY', 'RECORDING', 'PAUSED', 'STOPPED', 'GENERATING', 'IN_REVIEW'];
const METHODS = new Set(['CONFIRMED_SUGGESTION', 'CHOSE_ALTERNATIVE', 'RESOLVED_AMBIGUITY', 'CHOSE_FROM_DIARY']);
const CONSENT = new Set(['PENDING', 'GIVEN', 'DECLINED']);
const APPOINTMENT_STATES = new Set<string>([...KNOWN_APPOINTMENT_STATES, 'Unknown']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Storage may leave out an empty array; anything else that is not an array of objects is malformed. */
const objArray = (v: unknown): Obj[] | null => (v === undefined ? [] : Array.isArray(v) && v.every(isObj) ? v : null);

function sessionToRow(s: ScribeSession): Record<string, unknown> {
  return compact({
    session_id: s.sessionId,
    clinic_id: s.clinicId,
    clinician_id: s.clinicianId,
    surgery_id: s.surgeryId,
    status: s.status,
    dentally_patient_id: s.patient.dentallyPatientId,
    dentally_appointment_id: s.patient.appointment.appointmentId,
    appointment: {
      dentally_appointment_id: s.patient.appointment.appointmentId,
      practitioner_id: s.patient.appointment.practitionerId,
      room_id: s.patient.appointment.roomId,
      start_time: msToIso(s.patient.appointment.startMs),
      finish_time: msToIso(s.patient.appointment.finishMs),
      reason: s.patient.appointment.reason,
      state_at_confirmation: s.patient.appointment.stateAtConfirmation,
    },
    confirmation: {
      method: s.confirmation.method,
      predicted_appointment_id: s.confirmation.predictedAppointmentId,
      matched_prediction: s.confirmation.matchedPrediction,
      confirmed_by_email: s.confirmation.confirmedBy,
      confirmed_at: msToIso(s.confirmation.confirmedAtMs),
    },
    consent: { status: s.consent.status, recorded_by_email: s.consent.recordedBy, recorded_at: msToIso(s.consent.recordedAtMs) },
    reassignments: s.reassignments.map((r) => ({
      from_patient_id: r.fromPatientId,
      to_patient_id: r.toPatientId,
      from_appointment_id: r.fromAppointmentId,
      to_appointment_id: r.toAppointmentId,
      by_email: r.by,
      at: msToIso(r.atMs),
      reason: r.reason,
      consent_carried_over: r.consentCarriedOver,
    })),
    status_history: s.statusHistory.map((h) => ({ status: h.status, at: msToIso(h.atMs), by_email: h.by })),
    recording_started_at: msToIso(s.recordingStartedAtMs),
    recording_stopped_at: msToIso(s.recordingStoppedAtMs),
    client_device_id: s.clientDeviceId,
    version: s.version,
  });
}

function rowToSession(r: Row): ScribeSession {
  const a = (isObj(r.appointment) ? r.appointment : {}) as Obj;
  const c = (isObj(r.confirmation) ? r.confirmation : {}) as Obj;
  const k = (isObj(r.consent) ? r.consent : {}) as Obj;
  const reassignments = objArray(r.reassignments);
  const history = objArray(r.status_history);
  // A malformed row is an error, never an active session for an unknown patient.
  const valid =
    str(r.session_id) && str(r.clinic_id) && str(r.clinician_id) && str(r.dentally_patient_id) &&
    typeof r.status === 'string' && SESSION_STATUSES.has(r.status) &&
    str(a.dentally_appointment_id) && str(a.practitioner_id) && isoToMs(a.start_time) !== null && isoToMs(a.finish_time) !== null &&
    typeof a.state_at_confirmation === 'string' && APPOINTMENT_STATES.has(a.state_at_confirmation) &&
    typeof c.method === 'string' && METHODS.has(c.method) && str(c.confirmed_by_email) && isoToMs(c.confirmed_at) !== null &&
    typeof k.status === 'string' && CONSENT.has(k.status) &&
    typeof r.version === 'number' && Number.isSafeInteger(r.version) && r.version >= 1 &&
    reassignments !== null &&
    reassignments.every(
      (x) =>
        str(x.from_patient_id) && str(x.to_patient_id) && str(x.from_appointment_id) && str(x.to_appointment_id) &&
        str(x.by_email) && isoToMs(x.at) !== null && typeof x.reason === 'string',
    ) &&
    history !== null &&
    history.every((h) => typeof h.status === 'string' && SESSION_STATUSES.has(h.status) && isoToMs(h.at) !== null && str(h.by_email));
  if (!valid || reassignments === null || history === null) throw new AppError('INTERNAL', UNREADABLE);
  return {
    sessionId: String(r.session_id),
    clinicId: String(r.clinic_id),
    clinicianId: String(r.clinician_id),
    surgeryId: str(r.surgery_id),
    status: r.status as ScribeSession['status'],
    patient: {
      dentallyPatientId: String(r.dentally_patient_id),
      appointment: {
        appointmentId: String(a.dentally_appointment_id),
        practitionerId: String(a.practitioner_id),
        roomId: str(a.room_id),
        startMs: isoToMs(a.start_time) ?? 0,
        finishMs: isoToMs(a.finish_time) ?? 0,
        reason: str(a.reason),
        stateAtConfirmation: a.state_at_confirmation as ScribeSession['patient']['appointment']['stateAtConfirmation'],
      },
    },
    confirmation: {
      method: c.method as ScribeSession['confirmation']['method'],
      predictedAppointmentId: str(c.predicted_appointment_id),
      matchedPrediction: c.matched_prediction === true,
      confirmedBy: String(c.confirmed_by_email ?? ''),
      confirmedAtMs: isoToMs(c.confirmed_at) ?? 0,
    },
    consent: {
      status: (str(k.status) ?? 'PENDING') as ScribeSession['consent']['status'],
      recordedBy: str(k.recorded_by_email),
      recordedAtMs: isoToMs(k.recorded_at),
    },
    reassignments: reassignments.map((x) => ({
      fromPatientId: String(x.from_patient_id),
      toPatientId: String(x.to_patient_id),
      fromAppointmentId: String(x.from_appointment_id),
      toAppointmentId: String(x.to_appointment_id),
      by: String(x.by_email),
      atMs: isoToMs(x.at) ?? 0,
      reason: String(x.reason ?? ''),
      consentCarriedOver: x.consent_carried_over === true,
    })),
    statusHistory: history.map((h) => ({
      status: h.status as ScribeSession['status'],
      atMs: isoToMs(h.at) ?? 0,
      by: String(h.by_email ?? ''),
    })),
    recordingStartedAtMs: isoToMs(r.recording_started_at),
    recordingStoppedAtMs: isoToMs(r.recording_stopped_at),
    clientDeviceId: str(r.client_device_id),
    version: typeof r.version === 'number' ? r.version : 0,
  };
}

export class Base44SessionRepository implements SessionRepository {
  constructor(private readonly base44: Base44Like) {}

  private get entity(): EntityApi {
    return this.base44.asServiceRole.entities.ScribeSession!;
  }

  async create(session: ScribeSession): Promise<void> {
    await this.entity.create(sessionToRow(session));
  }

  async get(clinicId: string, sessionId: string): Promise<ScribeSession | null> {
    const found = await allRows(this.entity, { clinic_id: clinicId, session_id: sessionId });
    if (found.length > 1) throw new AppError('INTERNAL', UNREADABLE); // session IDs are unique
    return found[0] ? rowToSession(found[0]) : null;
  }

  /** Compare-and-set: only the row still at `expectedVersion` is updated. */
  async update(session: ScribeSession, expectedVersion: number): Promise<void> {
    const result = await this.entity.updateMany(
      { clinic_id: session.clinicId, session_id: session.sessionId, version: expectedVersion },
      { $set: sessionToRow(session) },
    );
    if (!result || result.updated !== 1) throw new VersionConflictError();
  }

  async findActive(
    clinicId: string,
    filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null },
  ): Promise<ScribeSession[]> {
    const open = { clinic_id: clinicId, status: { $in: ACTIVE_STATUSES } };
    const queries: Record<string, unknown>[] = [];
    if (filter.surgeryId) queries.push({ ...open, surgery_id: filter.surgeryId });
    if (filter.clinicianId) queries.push({ ...open, clinician_id: filter.clinicianId });
    if (filter.patientId) queries.push({ ...open, dentally_patient_id: filter.patientId });
    const found = new Map<string, ScribeSession>();
    for (const q of queries) {
      for (const r of await allRows(this.entity, q)) {
        const s = rowToSession(r);
        if (!isTerminal(s.status)) found.set(s.sessionId, s);
      }
    }
    return [...found.values()];
  }

  async findByAppointments(clinicId: string, appointmentIds: readonly string[]): Promise<ScribeSession[]> {
    if (appointmentIds.length === 0) return [];
    return (await allRows(this.entity, { clinic_id: clinicId, dentally_appointment_id: { $in: [...appointmentIds] } })).map(rowToSession);
  }
}

export class Base44AuditSink implements AuditSink {
  constructor(private readonly base44: Base44Like) {}

  async append(e: AuditEvent): Promise<void> {
    await this.base44.asServiceRole.entities.AuditEvent!.create(compact({
      clinic_id: e.clinicId,
      occurred_at: new Date(e.occurredAtMs).toISOString(),
      actor_email: e.actorEmail,
      actor_roles: e.actorRoles,
      action: e.action,
      session_id: e.sessionId,
      dentally_patient_id: e.dentallyPatientId,
      dentally_appointment_id: e.dentallyAppointmentId,
      details: e.details,
      client: { device_id: e.client.deviceId, app_version: e.client.appVersion },
      dedupe_key: e.dedupeKey,
    }));
  }

  async hasRecent(clinicId: string, actorEmail: string, dedupeKey: string, sinceMs: number): Promise<boolean> {
    const found = rows(
      await this.base44.asServiceRole.entities.AuditEvent!.filter(
        { clinic_id: clinicId, actor_email: actorEmail, dedupe_key: dedupeKey, occurred_at: { $gte: new Date(sinceMs).toISOString() } },
        { limit: 1 },
      ),
    );
    return found.length > 0;
  }
}

const CLINICIAN_TYPES = new Set(['DENTIST', 'THERAPIST', 'HYGIENIST', 'OTHER']);

function rowToClinician(r: Row): ClinicianRecord {
  const practitionerId = str(r.dentally_practitioner_id);
  const displayName = str(r.display_name);
  // A clinician without an ID or name would appear as "undefined" on the setup screen: refuse instead.
  if (!practitionerId || !displayName || r.active === undefined) throw new AppError('INTERNAL', UNREADABLE);
  return {
    practitionerId,
    displayName,
    clinicianType: (CLINICIAN_TYPES.has(String(r.clinician_type)) ? r.clinician_type : 'OTHER') as ClinicianEntry['clinicianType'],
    dentallyUserId: str(r.dentally_user_id),
    active: r.active === true,
  };
}

function rowToSurgery(r: Row): SurgeryRecord {
  const surgeryId = str(r.id);
  const name = str(r.name);
  if (!surgeryId || !name || r.active === undefined) throw new AppError('INTERNAL', UNREADABLE);
  return { surgeryId, name, roomId: str(r.dentally_room_id), active: r.active === true };
}

function rowToStaff(r: Row): StaffProfileRecord {
  const email = str(r.user_email);
  const displayName = str(r.display_name);
  if (!email || !displayName || !Array.isArray(r.app_roles)) throw new AppError('INTERNAL', UNREADABLE);
  return {
    email,
    displayName,
    roles: r.app_roles.filter((x): x is AppRole => (APP_ROLES as readonly unknown[]).includes(x)),
    clinicianId: str(r.clinician_id),
    active: r.active === true,
  };
}

export class Base44ClinicDirectory implements ClinicDirectory, ClinicAdminStore {
  constructor(private readonly base44: Base44Like) {}

  private entity(name: 'Clinician' | 'Surgery' | 'StaffProfile'): EntityApi {
    return this.base44.asServiceRole.entities[name]!;
  }

  async listClinicians(clinicId: string): Promise<ClinicianEntry[]> {
    return (await this.listClinicianRecords(clinicId)).filter((c) => c.active).map(({ practitionerId, displayName, clinicianType }) => ({ practitionerId, displayName, clinicianType }));
  }

  async listSurgeries(clinicId: string): Promise<SurgeryEntry[]> {
    return (await this.listSurgeryRecords(clinicId)).filter((x) => x.active).map(({ surgeryId, name, roomId }) => ({ surgeryId, name, roomId }));
  }

  async listClinicianRecords(clinicId: string): Promise<ClinicianRecord[]> {
    return (await allRows(this.entity('Clinician'), { clinic_id: clinicId })).map(rowToClinician);
  }

  async saveClinicianRecords(clinicId: string, records: readonly ClinicianRecord[]): Promise<void> {
    for (const r of records) {
      const data = compact({
        clinic_id: clinicId,
        dentally_practitioner_id: r.practitionerId,
        dentally_user_id: r.dentallyUserId,
        display_name: r.displayName,
        clinician_type: r.clinicianType,
        active: r.active,
      });
      const existing = await allRows(this.entity('Clinician'), { clinic_id: clinicId, dentally_practitioner_id: r.practitionerId });
      if (existing.length > 1) throw new AppError('INTERNAL', UNREADABLE);
      if (existing[0]?.id) await this.entity('Clinician').update(existing[0].id, data);
      else await this.entity('Clinician').create(data);
    }
  }

  async listSurgeryRecords(clinicId: string): Promise<SurgeryRecord[]> {
    return (await allRows(this.entity('Surgery'), { clinic_id: clinicId })).map(rowToSurgery);
  }

  async saveSurgeryRecords(clinicId: string, records: readonly Omit<SurgeryRecord, 'surgeryId'>[]): Promise<void> {
    for (const r of records) {
      const data = compact({ clinic_id: clinicId, name: r.name, dentally_room_id: r.roomId, active: r.active });
      const existing = r.roomId ? await allRows(this.entity('Surgery'), { clinic_id: clinicId, dentally_room_id: r.roomId }) : [];
      if (existing.length > 1) throw new AppError('INTERNAL', UNREADABLE);
      if (existing[0]?.id) await this.entity('Surgery').update(existing[0].id, data);
      else await this.entity('Surgery').create(data);
    }
  }

  async listStaff(clinicId: string): Promise<StaffProfileRecord[]> {
    return (await allRows(this.entity('StaffProfile'), { clinic_id: clinicId })).map(rowToStaff);
  }

  async saveStaff(clinicId: string, record: StaffProfileRecord): Promise<void> {
    const data = compact({
      clinic_id: clinicId,
      user_email: record.email,
      display_name: record.displayName,
      app_roles: record.roles,
      clinician_id: record.clinicianId,
      active: record.active,
    });
    const existing = await allRows(this.entity('StaffProfile'), { clinic_id: clinicId, user_email: record.email });
    if (existing.length > 1) throw new AppError('INTERNAL', UNREADABLE);
    // A cleared clinician link must be removed, not left behind by an update that omits it.
    if (existing[0]?.id) await this.entity('StaffProfile').update(existing[0].id, { ...data, clinician_id: record.clinicianId ?? '' });
    else await this.entity('StaffProfile').create(data);
  }
}

/** Clinic creation for first-run setup (bootstrapClinic). */
export class Base44ClinicRegistry implements ClinicRegistry {
  constructor(private readonly base44: Base44Like) {}

  async findBySlug(slug: string): Promise<ClinicRow[]> {
    return (await allRows(this.base44.asServiceRole.entities.Clinic!, { slug })).map((r) => {
      const id = str(r.id);
      const createdAtMs = isoToMs(r.created_date);
      if (!id || createdAtMs === null) throw new AppError('INTERNAL', UNREADABLE);
      return { id, slug, status: String(r.status ?? ''), createdAtMs };
    });
  }

  async create(input: { name: string; slug: string; timeZone: string }): Promise<ClinicRow> {
    const r = await this.base44.asServiceRole.entities.Clinic!.create({
      name: input.name,
      slug: input.slug,
      time_zone: input.timeZone,
      status: 'ACTIVE',
      tooth_notation: 'PALMER',
    });
    const id = str(r.id);
    if (!id) throw new AppError('INTERNAL', UNREADABLE);
    return { id, slug: input.slug, status: 'ACTIVE', createdAtMs: isoToMs(r.created_date) ?? Date.now() };
  }

  async suspend(id: string): Promise<void> {
    await this.base44.asServiceRole.entities.Clinic!.update(id, { status: 'SUSPENDED' });
  }

  async createStaffProfile(clinicId: string, record: StaffProfileRecord): Promise<void> {
    await new Base44ClinicDirectory(this.base44).saveStaff(clinicId, record);
  }
}

// ---------------------------------------------------------------------------
// Scribe content: transcript segments and nurse notes, encrypted, deleted by the end of the next day.

const SPEAKER = /^[A-Za-z0-9_]{1,8}$/;
const SEGMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function rowToSegment(r: Row): StoredSegment {
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const segmentId = str(r.segment_id);
  const seq = n(r.seq);
  const startMs = n(r.start_ms);
  const endMs = n(r.end_ms);
  const cipherText = str(r.cipher_text);
  const capturedBy = str(r.captured_by_email);
  const savedAtMs = isoToMs(r.saved_at);
  const deleteAfterMs = isoToMs(r.delete_after);
  const speaker = r.speaker === undefined || r.speaker === null ? null : str(r.speaker);
  const kind = r.kind === 'SPEECH' || r.kind === 'GAP' ? r.kind : null;
  if (
    !kind || !segmentId || !SEGMENT_ID.test(segmentId) || seq === null || startMs === null || endMs === null || !cipherText || !capturedBy ||
    savedAtMs === null || deleteAfterMs === null || (speaker !== null && !SPEAKER.test(speaker))
  ) {
    throw new AppError('INTERNAL', UNREADABLE);
  }
  return { kind, segmentId, seq, startMs, endMs, speaker, cipherText, capturedBy, savedAtMs, deleteAfterMs };
}

export class Base44ScribeContentStore implements ScribeContentStore {
  constructor(private readonly base44: Base44Like) {}

  private get segments(): EntityApi {
    return this.base44.asServiceRole.entities.TranscriptSegment!;
  }

  private get notes(): EntityApi {
    return this.base44.asServiceRole.entities.NurseNote!;
  }

  async listSegments(clinicId: string, sessionId: string): Promise<StoredSegment[]> {
    return (await allRows(this.segments, { clinic_id: clinicId, session_id: sessionId })).map(rowToSegment);
  }

  async addSegments(clinicId: string, sessionId: string, list: readonly StoredSegment[]): Promise<number> {
    if (list.length === 0) return 0;
    // Only the incoming IDs are checked, so a save costs the same early and late in a long appointment.
    const existing = new Set(
      (await allRows(this.segments, { clinic_id: clinicId, session_id: sessionId, segment_id: { $in: list.map((s) => s.segmentId) } })).map((r) =>
        str(r.segment_id),
      ),
    );
    let added = 0;
    for (const s of list) {
      if (existing.has(s.segmentId)) continue;
      await this.segments.create(compact({
        clinic_id: clinicId,
        session_id: sessionId,
        kind: s.kind,
        segment_id: s.segmentId,
        seq: s.seq,
        start_ms: s.startMs,
        end_ms: s.endMs,
        speaker: s.speaker,
        cipher_text: s.cipherText,
        captured_by_email: s.capturedBy,
        saved_at: msToIso(s.savedAtMs),
        delete_after: msToIso(s.deleteAfterMs),
      }));
      existing.add(s.segmentId);
      added += 1;
    }
    return added;
  }

  private async noteRows(clinicId: string, sessionId: string): Promise<Row[]> {
    const found = await allRows(this.notes, { clinic_id: clinicId, session_id: sessionId });
    if (found.length > 1) throw new AppError('INTERNAL', UNREADABLE); // one per session
    return found;
  }

  async getNurseNote(clinicId: string, sessionId: string): Promise<StoredNurseNote | null> {
    const r = (await this.noteRows(clinicId, sessionId))[0];
    if (!r) return null;
    const cipherText = str(r.cipher_text);
    const updatedBy = str(r.updated_by_email);
    const updatedAtMs = isoToMs(r.updated_at);
    const deleteAfterMs = isoToMs(r.delete_after);
    if (!cipherText || !updatedBy || updatedAtMs === null || deleteAfterMs === null || typeof r.revision !== 'number' || r.revision < 1) {
      throw new AppError('INTERNAL', UNREADABLE);
    }
    return { cipherText, revision: r.revision, updatedBy, updatedAtMs, deleteAfterMs };
  }

  async saveNurseNote(clinicId: string, sessionId: string, note: StoredNurseNote, expectedRevision: number): Promise<void> {
    const row = {
      clinic_id: clinicId,
      session_id: sessionId,
      cipher_text: note.cipherText,
      revision: note.revision,
      updated_by_email: note.updatedBy,
      updated_at: msToIso(note.updatedAtMs),
      delete_after: msToIso(note.deleteAfterMs),
    };
    if (expectedRevision === 0) {
      if ((await this.noteRows(clinicId, sessionId)).length > 0) throw new VersionConflictError();
      const mine = await this.notes.create(row);
      // Two first saves at the same moment: the earliest stored wins, the other is removed and refused.
      const all = await allRows(this.notes, { clinic_id: clinicId, session_id: sessionId });
      if (all.length > 1) {
        const order = (r: Row) => `${str(r.created_date) ?? ''}|${r.id ?? ''}`;
        const first = [...all].sort((a, b) => (order(a) < order(b) ? -1 : 1))[0];
        if (first?.id !== mine.id) {
          if (mine.id) await this.notes.delete(mine.id);
          throw new VersionConflictError();
        }
      }
      return;
    }
    const result = await this.notes.updateMany({ clinic_id: clinicId, session_id: sessionId, revision: expectedRevision }, { $set: row });
    if (!result || result.updated !== 1) throw new VersionConflictError();
  }

  /** Deletes every row matching the query and checks none is left. Returns how many there were. */
  private async deleteAll(entity: EntityApi, query: Record<string, unknown>, limit = Number.POSITIVE_INFINITY): Promise<number> {
    const found = rows(await entity.filter(query, { limit: 1 }));
    if (found.length === 0) return 0;
    const before = await allRows(entity, query);
    if (before.length <= limit) {
      await entity.deleteMany(query);
      if (rows(await entity.filter(query, { limit: 1 })).length === 0) return before.length;
    }
    // Bulk delete unavailable, partial, or over the limit: one at a time, then check again.
    let count = 0;
    for (const r of before) {
      if (count >= limit) break;
      if (!r.id) throw new AppError('INTERNAL', UNREADABLE);
      await entity.delete(r.id);
      count += 1;
    }
    if (count < limit && rows(await entity.filter(query, { limit: 1 })).length > 0) throw new AppError('INTERNAL', UNREADABLE);
    return count;
  }

  async deleteSession(clinicId: string, sessionId: string): Promise<number> {
    const query = { clinic_id: clinicId, session_id: sessionId };
    return (await this.deleteAll(this.segments, query)) + (await this.deleteAll(this.notes, query));
  }

  async purgeExpired(clinicId: string, nowMs: number, limit: number): Promise<number> {
    const query = { clinic_id: clinicId, delete_after: { $lte: new Date(nowMs).toISOString() } };
    const segments = await this.deleteAll(this.segments, query, limit);
    return segments + (await this.deleteAll(this.notes, query, Math.max(0, limit - segments)));
  }
}

/** Swaps the long-lived Speechmatics key (a Base44 secret) for a key that lasts a minute, for the browser. */
export class SpeechmaticsTokenIssuer implements SpeechTokenIssuer {
  readonly provider = 'SPEECHMATICS' as const;
  constructor(private readonly readSecret: SecretReader, private readonly fetchImpl: typeof fetch = fetch) {}

  async issue(): Promise<SpeechToken> {
    const apiKey = this.readSecret('SPEECHMATICS_API_KEY');
    if (!apiKey) throw new SpeechServiceError('NOT_CONFIGURED');
    let res: Response;
    try {
      res = await this.fetchImpl(SPEECHMATICS_TEMP_KEY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ ttl: SPEECHMATICS_TEMP_KEY_TTL_SECONDS }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SpeechServiceError('UNAVAILABLE');
    }
    if (res.status === 401 || res.status === 403) throw new SpeechServiceError('AUTH');
    if (!res.ok) throw new SpeechServiceError('UNAVAILABLE');
    const body = (await res.json().catch(() => null)) as { key_value?: unknown } | null;
    const key = typeof body?.key_value === 'string' ? body.key_value : '';
    if (!key) throw new SpeechServiceError('UNAVAILABLE');
    return {
      provider: 'SPEECHMATICS',
      url: `${SPEECHMATICS_RT_URL}?jwt=${encodeURIComponent(key)}`,
      expiresAtMs: Date.now() + SPEECHMATICS_TEMP_KEY_TTL_SECONDS * 1000,
    };
  }
}

// ---------------------------------------------------------------------------
// Wiring

export async function buildDeps(base44: Base44Like, clinic: ClinicConfig, readSecret: SecretReader): Promise<HandlerDeps> {
  let cipher: Promise<ContentCipher> | undefined;
  const client = new DentallyClient({
    baseUrl: requireSecret(readSecret, 'DENTALLY_BASE_URL'),
    token: requireSecret(readSecret, 'DENTALLY_API_TOKEN'),
    userAgent: requireSecret(readSecret, 'DENTALLY_USER_AGENT'),
  });
  return {
    clock: () => Date.now(),
    newId: () => crypto.randomUUID(),
    clinic,
    dentally: createLiveDentallyService(client),
    sessions: new Base44SessionRepository(base44),
    audit: new Base44AuditSink(base44),
    directory: new Base44ClinicDirectory(base44),
    admin: new Base44ClinicDirectory(base44),
    content: new Base44ScribeContentStore(base44),
    cipher: () => {
      cipher ??= AesGcmContentCipher.fromBase64Key(requireSecret(readSecret, 'CONTENT_ENCRYPTION_KEY'));
      return cipher;
    },
    speech: new SpeechmaticsTokenIssuer(readSecret),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) return jsonResponse(err.toJSON(), err.httpStatus);
  // Unknown errors: log the type only (messages may contain data), return a generic message.
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[auranotetaker] unexpected ${err instanceof Error ? err.name : typeof err} ref=${ref}`);
  return jsonResponse({ error: { code: 'INTERNAL', message: `Something went wrong (ref ${ref}).`, details: {} } }, 500);
}

/** Standard function body: authenticate, resolve clinic and caller, run one handler. */
export async function runHandler<I, O>(
  req: Request,
  createClient: (req: Request) => Base44Like,
  handler: (ctx: StaffContext, deps: HandlerDeps, input: I) => Promise<O>,
  readSecret: SecretReader,
): Promise<Response> {
  try {
    if (req.method !== 'POST') return jsonResponse({ error: { code: 'VALIDATION', message: 'POST only', details: {} } }, 405);
    const base44 = createClient(req);
    const clinic = await resolveClinic(base44, readSecret);
    const ctx = await resolveContext(base44, clinic, req.headers);
    const input = (await req.json().catch(() => ({}))) as I;
    const deps = await buildDeps(base44, clinic, readSecret);
    return jsonResponse(await handler(ctx, deps, input));
  } catch (err) {
    return errorResponse(err);
  }
}

/** First-run setup: creates the clinic and makes the app's owner its first practice manager. */
export async function runBootstrap(req: Request, createClient: (req: Request) => Base44Like, readSecret: SecretReader): Promise<Response> {
  try {
    if (req.method !== 'POST') return jsonResponse({ error: { code: 'VALIDATION', message: 'POST only', details: {} } }, 405);
    const base44 = createClient(req);
    const me = await base44.auth.me().catch(() => null);
    const email = str(me?.email)?.toLowerCase();
    if (!email) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
    const caller: BootstrapCaller = { email, displayName: str(me?.full_name) ?? email, isAppAdmin: me?.role === 'admin' };
    const input = (await req.json().catch(() => ({}))) as { clinicName?: unknown };
    const result = await bootstrapClinic(
      caller,
      {
        registry: new Base44ClinicRegistry(base44),
        audit: new Base44AuditSink(base44),
        clock: () => Date.now(),
        clinicKey: requireSecret(readSecret, 'CLINIC_KEY'),
      },
      input,
    );
    return jsonResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
