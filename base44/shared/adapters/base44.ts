// Base44 adapters: resolve the caller and build handler dependencies inside a Base44 backend function.
//
// NOT YET VERIFIED against a live Base44 app (issue P1-01). Assumptions to confirm when the app exists:
//   - functions run on Deno and read secrets with Deno.env.get
//   - createClientFromRequest(req).asServiceRole.entities.<Name> bypasses entity access rules (per SDK 0.8 docs)
//   - entity filter(query, { limit }) returns { items } (newer SDK) or an array (older); both handled below
//
// SECURITY: roles and clinic membership come from the StaffProfile entity, which only functions can write.
// They are never read from the Base44 user record, because users can edit their own custom user fields.

import type { AuditEvent } from '../lib/core/audit.ts';
import type { ScribeSession } from '../lib/core/session.ts';
import { isTerminal } from '../lib/core/session.ts';
import { DentallyClient } from '../lib/dentally/client.ts';
import { createLiveDentallyService } from '../lib/dentally/service.ts';
import { AppError } from '../lib/server/errors.ts';
import type {
  AppRole,
  AuditSink,
  ClinicConfig,
  ClinicDirectory,
  ClinicianEntry,
  HandlerDeps,
  SessionRepository,
  StaffContext,
  SurgeryEntry,
} from '../lib/server/ports.ts';
import { APP_ROLES, VersionConflictError } from '../lib/server/ports.ts';

// Minimal structural types so this file does not depend on SDK type definitions.
type Row = Record<string, unknown> & { id?: string };
interface EntityApi {
  filter(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  create(data: Record<string, unknown>): Promise<Row>;
  update(id: string, data: Record<string, unknown>): Promise<Row>;
}
export interface Base44Like {
  auth: { me(): Promise<{ email?: string | null; full_name?: string | null } | null> };
  asServiceRole: { entities: Record<string, EntityApi> };
}

declare const Deno: { env: { get(name: string): string | undefined } };

const APP_VERSION = '0.1.0';

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { items?: unknown }).items)) {
    return (result as { items: Row[] }).items;
  }
  return [];
}

function secret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new AppError('INTERNAL', 'AuraNoteTaker is not fully configured. Please tell the practice manager.');
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isoToMs = (v: unknown): number | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const msToIso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

// ---------------------------------------------------------------------------
// Caller and clinic

export async function resolveClinic(base44: Base44Like): Promise<ClinicConfig> {
  const clinicKey = secret('CLINIC_KEY');
  const clinic = rows(await base44.asServiceRole.entities.Clinic!.filter({ slug: clinicKey, status: 'ACTIVE' }, { limit: 1 }))[0];
  if (!clinic?.id) throw new AppError('INTERNAL', 'Clinic is not configured.');
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
    deviceId: str(headers.get('x-device-id'))?.slice(0, 64) ?? null,
    appVersion: APP_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Repositories on Base44 entities (service role; entity rules deny direct client access)

function sessionToRow(s: ScribeSession): Record<string, unknown> {
  return {
    session_id: s.sessionId,
    clinic_id: s.clinicId,
    clinician_id: s.clinicianId,
    surgery_id: s.surgeryId,
    status: s.status,
    dentally_patient_id: s.patient.dentallyPatientId,
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
  };
}

function rowToSession(r: Row): ScribeSession {
  const a = (r.appointment ?? {}) as Record<string, unknown>;
  const c = (r.confirmation ?? {}) as Record<string, unknown>;
  const k = (r.consent ?? {}) as Record<string, unknown>;
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
        stateAtConfirmation: (str(a.state_at_confirmation) ?? 'Unknown') as ScribeSession['patient']['appointment']['stateAtConfirmation'],
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
    reassignments: (Array.isArray(r.reassignments) ? r.reassignments : []).map((x: Record<string, unknown>) => ({
      fromPatientId: String(x.from_patient_id),
      toPatientId: String(x.to_patient_id),
      fromAppointmentId: String(x.from_appointment_id),
      toAppointmentId: String(x.to_appointment_id),
      by: String(x.by_email),
      atMs: isoToMs(x.at) ?? 0,
      reason: String(x.reason ?? ''),
      consentCarriedOver: x.consent_carried_over === true,
    })),
    statusHistory: (Array.isArray(r.status_history) ? r.status_history : []).map((h: Record<string, unknown>) => ({
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

  private async row(clinicId: string, sessionId: string): Promise<Row | null> {
    return rows(await this.entity.filter({ clinic_id: clinicId, session_id: sessionId }, { limit: 1 }))[0] ?? null;
  }

  async create(session: ScribeSession): Promise<void> {
    await this.entity.create(sessionToRow(session));
  }

  async get(clinicId: string, sessionId: string): Promise<ScribeSession | null> {
    const r = await this.row(clinicId, sessionId);
    return r ? rowToSession(r) : null;
  }

  // Base44 has no conditional update, so this is read-check-write. The window is small and the
  // handler has already checked the version; Phase 7 revisits this if Base44 adds compare-and-set.
  async update(session: ScribeSession, expectedVersion: number): Promise<void> {
    const r = await this.row(session.clinicId, session.sessionId);
    if (!r?.id || r.version !== expectedVersion) throw new VersionConflictError();
    await this.entity.update(r.id, sessionToRow(session));
  }

  async findActive(
    clinicId: string,
    filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null },
  ): Promise<ScribeSession[]> {
    const queries: Record<string, unknown>[] = [];
    if (filter.surgeryId) queries.push({ clinic_id: clinicId, surgery_id: filter.surgeryId });
    if (filter.clinicianId) queries.push({ clinic_id: clinicId, clinician_id: filter.clinicianId });
    if (filter.patientId) queries.push({ clinic_id: clinicId, dentally_patient_id: filter.patientId });
    const found = new Map<string, ScribeSession>();
    for (const q of queries) {
      for (const r of rows(await this.entity.filter(q, { limit: 50, sort: '-created_date' }))) {
        const s = rowToSession(r);
        if (!isTerminal(s.status)) found.set(s.sessionId, s);
      }
    }
    return [...found.values()];
  }
}

export class Base44AuditSink implements AuditSink {
  constructor(private readonly base44: Base44Like) {}

  async append(e: AuditEvent): Promise<void> {
    await this.base44.asServiceRole.entities.AuditEvent!.create({
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
    });
  }
}

export class Base44ClinicDirectory implements ClinicDirectory {
  constructor(private readonly base44: Base44Like) {}

  async listClinicians(clinicId: string): Promise<ClinicianEntry[]> {
    return rows(await this.base44.asServiceRole.entities.Clinician!.filter({ clinic_id: clinicId, active: true }, { limit: 200 })).map((r) => ({
      practitionerId: String(r.dentally_practitioner_id),
      displayName: String(r.display_name),
      clinicianType: (str(r.clinician_type) ?? 'OTHER') as ClinicianEntry['clinicianType'],
    }));
  }

  async listSurgeries(clinicId: string): Promise<SurgeryEntry[]> {
    return rows(await this.base44.asServiceRole.entities.Surgery!.filter({ clinic_id: clinicId, active: true }, { limit: 100 })).map((r) => ({
      surgeryId: String(r.id),
      name: String(r.name),
      roomId: str(r.dentally_room_id),
    }));
  }
}

// ---------------------------------------------------------------------------
// Wiring

export async function buildDeps(base44: Base44Like, clinic: ClinicConfig): Promise<HandlerDeps> {
  const client = new DentallyClient({
    baseUrl: secret('DENTALLY_BASE_URL'),
    token: secret('DENTALLY_API_TOKEN'),
    userAgent: secret('DENTALLY_USER_AGENT'),
  });
  return {
    clock: () => Date.now(),
    newId: () => crypto.randomUUID(),
    clinic,
    dentally: createLiveDentallyService(client),
    sessions: new Base44SessionRepository(base44),
    audit: new Base44AuditSink(base44),
    directory: new Base44ClinicDirectory(base44),
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
): Promise<Response> {
  try {
    if (req.method !== 'POST') return jsonResponse({ error: { code: 'VALIDATION', message: 'POST only', details: {} } }, 405);
    const base44 = createClient(req);
    const clinic = await resolveClinic(base44);
    const ctx = await resolveContext(base44, clinic, req.headers);
    const input = (await req.json().catch(() => ({}))) as I;
    const deps = await buildDeps(base44, clinic);
    return jsonResponse(await handler(ctx, deps, input));
  } catch (err) {
    return errorResponse(err);
  }
}
