// Server handlers: the only path through which the web app reads the diary, confirms a
// patient or changes a session. Pure functions of (caller context, injected dependencies, input).
//
// SAFETY: every handler re-checks what the client claims. The caller's clinic and roles come
// from StaffContext (resolved server-side), never from input. Confirming a patient re-fetches
// the appointment and the patient from Dentally and refuses on any mismatch, and returns the
// identity it verified so the screen shows exactly who was locked (hazards H01, H17, H18).

import type { DiaryAppointment, DiaryAppointmentDto } from '../core/appointments.ts';
import { toDiaryDto } from '../core/appointments.ts';
import type { AuditAction } from '../core/audit.ts';
import { buildAuditEvent } from '../core/audit.ts';
import type { PredictionOptions } from '../core/prediction.ts';
import { predictLikelyPatient } from '../core/prediction.ts';
import type { ConfirmationMethod, ScribeSession, SessionEvent } from '../core/session.ts';
import { createSession, isTerminal, transition } from '../core/session.ts';
import { zonedDateString } from '../core/time.ts';
import { DentallyError } from '../dentally/client.ts';
import type { PatientSummary } from '../dentally/types.ts';
import { AppError } from './errors.ts';
import type { AppRole, ClinicianEntry, HandlerDeps, StaffContext, SurgeryEntry } from './ports.ts';
import { APP_ROLES, VersionConflictError } from './ports.ts';

export const CLINICAL_ROLES: readonly AppRole[] = ['DENTIST', 'THERAPIST', 'HYGIENIST', 'NURSE'];
const CONFIRMATION_METHODS: readonly ConfirmationMethod[] = ['CONFIRMED_SUGGESTION', 'CHOSE_ALTERNATIVE', 'RESOLVED_AMBIGUITY', 'CHOSE_FROM_DIARY'];
const DIARY_REASONS = ['INITIAL', 'REFRESH', 'MANUAL'] as const;
/** A diary view by the same person, for the same clinician and day, is recorded at most once per window. */
export const DIARY_AUDIT_WINDOW_MS = 15 * 60_000;
/** Statuses in which nothing has been recorded yet, so an abandoned session can be closed safely. */
const NOTHING_RECORDED = new Set<ScribeSession['status']>(['PATIENT_CONFIRMED', 'READY']);
/**
 * A session with nothing recorded is treated as abandoned this long after its appointment should have
 * ended. The end counts from confirmation for a patient taken in late, so a late start is not cut short.
 */
export const ABANDONED_AFTER_MS = 60 * 60_000;
const SYSTEM_ACTOR = { email: 'system', roles: ['SYSTEM'] };

// ---------------------------------------------------------------------------
// Response types (also used by the web app)

export interface MeResponse {
  email: string;
  displayName: string;
  roles: AppRole[];
  clinicName: string;
}

export interface SetupOptionsResponse {
  clinicName: string;
  timeZone: string;
  clinicians: ClinicianEntry[];
  surgeries: SurgeryEntry[];
}

export type ScribeOutcome = 'DECLINED' | 'APPROVED';

export interface DiaryResponse {
  date: string;
  timeZone: string;
  /** Server time when the diary was read. The web app uses it to correct for a wrong PC clock. */
  fetchedAt: string;
  practitionerId: string;
  appointments: DiaryAppointmentDto[];
  rejectedCount: number;
  /** Appointments whose scribe session ended today, so they are not suggested again after a refresh. */
  scribeOutcomes: Record<string, ScribeOutcome>;
  /** The clinic's prediction settings, so the web app and the server predict the same way. */
  predictionOptions: Partial<PredictionOptions>;
}

export interface PatientSummaryResponse extends PatientSummary {
  appointmentId: string;
}

export interface SessionResponse {
  session: ScribeSession;
}

export interface ConfirmPatientResponse extends SessionResponse {
  /** The identity the server verified with Dentally and locked to the session. */
  patient: PatientSummary;
}

/**
 * Why an open session can only be cancelled from this screen:
 * OTHER_SURGERY: it was started in another surgery (the clinician has moved), or this computer has no surgery set;
 * PREVIOUS_DAY: its appointment was on an earlier day;
 * NOT_MEMBER: the signed-in user neither confirmed its patient nor is its clinician.
 */
export type SessionRestriction = 'OTHER_SURGERY' | 'PREVIOUS_DAY' | 'NOT_MEMBER';

export interface ActiveSessionResponse {
  session: ScribeSession | null;
  restriction: SessionRestriction | null;
}

export interface DentallyStatusResponse {
  status: 'CONNECTED' | 'UNAVAILABLE' | 'AUTH_ERROR';
  mode: 'live' | 'mock';
  latencyMs: number | null;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function reqId(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return v;
}

function optId(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return reqId(v, field);
}

function reqEnum<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return v as T;
}

function reqInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return v;
}

function reqBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return v;
}

function optBool(v: unknown, field: string): boolean {
  return v === undefined || v === null ? false : reqBool(v, field);
}

interface AuditExtra {
  sessionId?: string | null;
  dentallyPatientId?: string | null;
  dentallyAppointmentId?: string | null;
  details?: Record<string, unknown>;
  dedupeKey?: string | null;
  /** For system actions (expiry, race resolution) taken during this caller's request. */
  actor?: { email: string; roles: string[] };
}

async function audit(ctx: StaffContext, deps: HandlerDeps, action: AuditAction, extra: AuditExtra = {}): Promise<void> {
  const { actor, ...rest } = extra;
  await deps.audit.append(
    buildAuditEvent({
      clinicId: ctx.clinicId,
      occurredAtMs: deps.clock(),
      actorEmail: actor?.email ?? ctx.email,
      actorRoles: actor?.roles ?? ctx.roles,
      action,
      ...rest,
      client: { deviceId: ctx.deviceId ?? null, appVersion: ctx.appVersion ?? null },
    }),
  );
}

/** Audit after a state change that has already been saved. Retried; if it still fails the caller is told, never left unaware. */
async function auditAfterChange(ctx: StaffContext, deps: HandlerDeps, action: AuditAction, extra: AuditExtra): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await audit(ctx, deps, action, extra);
      return;
    } catch (err) {
      if (attempt === 2) {
        throw new AppError('INTERNAL', 'The change was saved but could not be added to the audit trail. Please tell the practice manager.', {
          reason: err instanceof Error ? err.name : 'UNKNOWN',
        });
      }
    }
  }
}

async function requireRole(ctx: StaffContext, deps: HandlerDeps, roles: readonly AppRole[], operation: string): Promise<void> {
  // Defence in depth: single-clinic deployments resolve both sides from the same clinic, so this only
  // bites in multi-clinic operation (Phase 7), where it stops a profile acting on another clinic.
  if (ctx.clinicId !== deps.clinic.clinicId) {
    await audit(ctx, deps, 'ACCESS_DENIED', { details: { operation, reasonCode: 'CLINIC' } });
    throw new AppError('FORBIDDEN', 'You do not have access to this clinic.');
  }
  if (!ctx.roles.some((r) => roles.includes(r))) {
    await audit(ctx, deps, 'ACCESS_DENIED', { details: { operation, reasonCode: 'ROLE' } });
    throw new AppError('FORBIDDEN', 'Your role does not allow this.');
  }
}

/** The person who confirmed the session, or its clinician, may act on it. */
function isSessionMember(ctx: StaffContext, s: ScribeSession): boolean {
  return ctx.email === s.confirmation.confirmedBy || (ctx.clinicianId !== null && ctx.clinicianId === s.clinicianId);
}

async function callDentally<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DentallyError) {
      if (err.kind === 'AUTH' || err.kind === 'CONFIG') {
        throw new AppError('DENTALLY_AUTH', 'AuraNoteTaker could not sign in to Dentally. Please tell the practice manager.');
      }
      throw new AppError(
        'DENTALLY_UNAVAILABLE',
        'Dentally is not responding. A new session cannot start until it is back, because the patient cannot be verified.',
      );
    }
    throw err;
  }
}

function isTodayRange(startMs: number, finishMs: number, nowMs: number, timeZone: string): boolean {
  const today = zonedDateString(nowMs, timeZone);
  return zonedDateString(startMs, timeZone) === today || zonedDateString(finishMs, timeZone) === today;
}

const isToday = (a: DiaryAppointment, nowMs: number, tz: string) => isTodayRange(a.startMs, a.finishMs, nowMs, tz);
const sessionIsToday = (s: ScribeSession, nowMs: number, tz: string) =>
  isTodayRange(s.patient.appointment.startMs, s.patient.appointment.finishMs, nowMs, tz);

function predictionOptions(deps: HandlerDeps): Partial<PredictionOptions> {
  return { earlyStartMinutes: deps.clinic.settings.earlyStartMinutes, overrunMinutes: deps.clinic.settings.overrunMinutes };
}

async function requireClinician(deps: HandlerDeps, practitionerId: string): Promise<ClinicianEntry> {
  const clinician = (await deps.directory.listClinicians(deps.clinic.clinicId)).find((c) => c.practitionerId === practitionerId);
  if (!clinician) throw new AppError('VALIDATION', 'That clinician is not set up in AuraNoteTaker.');
  return clinician;
}

async function requireSurgery(deps: HandlerDeps, surgeryId: string | null): Promise<SurgeryEntry | null> {
  if (surgeryId === null) return null;
  const surgery = (await deps.directory.listSurgeries(deps.clinic.clinicId)).find((s) => s.surgeryId === surgeryId);
  if (!surgery) throw new AppError('VALIDATION', 'That surgery is not set up in AuraNoteTaker.');
  return surgery;
}

async function loadSession(ctx: StaffContext, deps: HandlerDeps, sessionId: string): Promise<ScribeSession> {
  const session = await deps.sessions.get(ctx.clinicId, sessionId);
  // Same answer for "missing" and "another clinic's": do not reveal that a session exists elsewhere.
  if (!session || session.clinicId !== ctx.clinicId) throw new AppError('NOT_FOUND', 'Session not found.');
  return session;
}

function abandonedAtMs(s: ScribeSession): number {
  const a = s.patient.appointment;
  return Math.max(a.finishMs, s.confirmation.confirmedAtMs + (a.finishMs - a.startMs)) + ABANDONED_AFTER_MS;
}

/**
 * Closes a session in which nothing was recorded once it is clearly abandoned: from an earlier day, or
 * an hour past the end of its appointment. Returns true when the session was closed (so it no longer
 * counts as open). Sessions with recordings are never closed here.
 */
async function expireIfAbandoned(ctx: StaffContext, deps: HandlerDeps, s: ScribeSession): Promise<boolean> {
  const now = deps.clock();
  if (!NOTHING_RECORDED.has(s.status)) return false;
  if (sessionIsToday(s, now, deps.clinic.timeZone) && now <= abandonedAtMs(s)) return false;
  const r = transition(s, { type: 'EXPIRE', by: SYSTEM_ACTOR.email, atMs: now });
  if (!r.ok) return false;
  try {
    await deps.sessions.update(r.session, s.version);
  } catch (err) {
    if (err instanceof VersionConflictError) return false; // changed elsewhere: leave it counted as open
    throw err;
  }
  await auditAfterChange(ctx, deps, 'SESSION_STATUS_CHANGED', {
    actor: SYSTEM_ACTOR,
    sessionId: s.sessionId,
    dentallyPatientId: s.patient.dentallyPatientId,
    dentallyAppointmentId: s.patient.appointment.appointmentId,
    details: { from: s.status, to: 'CANCELLED', reasonCode: 'EXPIRED' },
  });
  return true;
}

async function openSessions(
  ctx: StaffContext,
  deps: HandlerDeps,
  filter: { surgeryId?: string | null; clinicianId?: string | null; patientId?: string | null },
): Promise<ScribeSession[]> {
  const out: ScribeSession[] = [];
  for (const s of await deps.sessions.findActive(ctx.clinicId, filter)) {
    if (isTerminal(s.status)) continue;
    if (!(await expireIfAbandoned(ctx, deps, s))) out.push(s);
  }
  return out;
}

function outcomesFor(sessions: readonly ScribeSession[]): Record<string, ScribeOutcome> {
  const out: Record<string, ScribeOutcome> = {};
  for (const s of sessions) {
    const id = s.patient.appointment.appointmentId;
    if (s.status === 'APPROVED') out[id] = 'APPROVED';
    else if (s.status === 'CONSENT_DECLINED' && out[id] !== 'APPROVED') out[id] = 'DECLINED';
  }
  return out;
}

/**
 * After a failed save the session may or may not exist (a timeout can hide a save that went through).
 * The screen was told confirmation failed, so a session that did get saved is withdrawn, and the audit
 * trail says which case it was. If storage cannot be read, nothing is claimed: a stray session would
 * show up as an open session, which the screen offers to open or cancel.
 */
async function withdrawAfterFailedCreate(
  ctx: StaffContext,
  deps: HandlerDeps,
  session: ScribeSession,
  ids: { sessionId: string; dentallyPatientId: string; dentallyAppointmentId: string },
): Promise<void> {
  try {
    const stored = await deps.sessions.get(ctx.clinicId, session.sessionId);
    if (!stored) {
      await audit(ctx, deps, 'SESSION_CANCELLED', { ...ids, actor: SYSTEM_ACTOR, details: { reasonCode: 'CREATE_FAILED' } });
      return;
    }
    if (isTerminal(stored.status)) return;
    const r = transition(stored, { type: 'CANCEL', by: SYSTEM_ACTOR.email, atMs: deps.clock() });
    if (!r.ok) return;
    await deps.sessions.update(r.session, stored.version);
    await audit(ctx, deps, 'SESSION_CANCELLED', {
      ...ids,
      actor: SYSTEM_ACTOR,
      details: { statusBefore: stored.status, reasonCode: 'CREATE_UNCONFIRMED' },
    });
  } catch {
    // Storage unreachable: see above.
  }
}

async function applySessionEvent(
  deps: HandlerDeps,
  before: ScribeSession,
  expectedVersion: number,
  event: SessionEvent,
): Promise<ScribeSession> {
  if (before.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', 'This session was changed on another screen. Reload it before continuing.');
  }
  const result = transition(before, event);
  if (!result.ok) throw new AppError('SESSION_TRANSITION_REFUSED', result.message, { reason: result.code });
  try {
    await deps.sessions.update(result.session, expectedVersion);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new AppError('VERSION_CONFLICT', 'This session was changed on another screen. Reload it before continuing.');
    }
    throw err;
  }
  return result.session;
}

// ---------------------------------------------------------------------------
// Handlers

/** The signed-in user's own profile, for the header. Refused when the profile has no roles. */
export async function getMe(ctx: StaffContext, deps: HandlerDeps): Promise<MeResponse> {
  await requireRole(ctx, deps, APP_ROLES, 'getMe');
  return { email: ctx.email, displayName: ctx.displayName, roles: [...ctx.roles], clinicName: deps.clinic.name };
}

/** Clinician and surgery choices for the setup screen. No patient data. */
export async function getSetupOptions(ctx: StaffContext, deps: HandlerDeps): Promise<SetupOptionsResponse> {
  await requireRole(ctx, deps, [...CLINICAL_ROLES, 'CLINIC_ADMIN'], 'getSetupOptions');
  const [clinicians, surgeries] = await Promise.all([
    deps.directory.listClinicians(deps.clinic.clinicId),
    deps.directory.listSurgeries(deps.clinic.clinicId),
  ]);
  return { clinicName: deps.clinic.name, timeZone: deps.clinic.timeZone, clinicians, surgeries };
}

/** Today's diary for one configured clinician, minimised to what the scribe needs. */
export async function getDiary(ctx: StaffContext, deps: HandlerDeps, input: { practitionerId?: unknown; reason?: unknown }): Promise<DiaryResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'getDiary');
  const practitionerId = reqId(input.practitionerId, 'clinician');
  if (input.reason !== undefined) reqEnum(input.reason, DIARY_REASONS, 'reason'); // informational only; never decides auditing
  await requireClinician(deps, practitionerId);

  const now = deps.clock();
  const date = zonedDateString(now, deps.clinic.timeZone);
  const result = await callDentally(() =>
    deps.dentally.getClinicianAppointments({ date, practitionerId, siteId: deps.clinic.dentallySiteId }),
  );
  const appointments = result.appointments
    .filter((a) => a.practitionerId === practitionerId && isToday(a, now, deps.clinic.timeZone))
    .sort((x, y) => x.startMs - y.startMs || (x.appointmentId < y.appointmentId ? -1 : 1));

  // Every view is audited, at most once per person, clinician and day in each 15-minute window.
  // The decision is the server's; the client cannot opt out.
  const dedupeKey = `DIARY:${practitionerId}:${date}`;
  if (!(await deps.audit.hasRecent(ctx.clinicId, ctx.email, dedupeKey, now - DIARY_AUDIT_WINDOW_MS))) {
    await audit(ctx, deps, 'DIARY_VIEWED', {
      dedupeKey,
      details: { date, practitionerId, appointmentCount: appointments.length, rejectedCount: result.rejectedCount },
    });
  }

  const outcomes = outcomesFor(await deps.sessions.findByAppointments(ctx.clinicId, appointments.map((a) => a.appointmentId)));
  return {
    date,
    timeZone: deps.clinic.timeZone,
    fetchedAt: new Date(now).toISOString(),
    practitionerId,
    appointments: appointments.map(toDiaryDto),
    rejectedCount: result.rejectedCount,
    scribeOutcomes: outcomes,
    predictionOptions: predictionOptions(deps),
  };
}

/**
 * Name and date of birth for the patient booked in one of today's appointments, for the
 * identity check on the confirm card. Takes an appointment, not a patient ID, so the
 * scribe cannot be used to look up arbitrary patients. The response carries the patient ID,
 * so the screen can check it still matches the diary.
 */
export async function getPatientSummary(ctx: StaffContext, deps: HandlerDeps, input: { appointmentId?: unknown }): Promise<PatientSummaryResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'getPatientSummary');
  const appointmentId = reqId(input.appointmentId, 'appointment');
  const appointment = await callDentally(() => deps.dentally.getAppointment(appointmentId));
  if (!appointment || appointment.patientId === null) throw new AppError('NOT_FOUND', 'No patient is booked in that appointment.');
  if (!isToday(appointment, deps.clock(), deps.clinic.timeZone)) throw new AppError('NOT_TODAY', 'That appointment is not today.');
  await requireClinician(deps, appointment.practitionerId);
  const patientId = appointment.patientId;
  const patient = await callDentally(() => deps.dentally.getPatient(patientId));
  if (!patient) throw new AppError('NOT_FOUND', 'Dentally could not find the patient for that appointment.');
  await audit(ctx, deps, 'PATIENT_VIEWED', {
    dentallyPatientId: patient.patientId,
    dentallyAppointmentId: appointmentId,
    details: { purpose: 'IDENTITY_CHECK' },
  });
  return { ...patient, appointmentId };
}

/** Explicit, human-confirmed patient selection. Creates a session whose patient is locked. */
export async function confirmPatient(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: {
    appointmentId?: unknown;
    patientId?: unknown;
    practitionerId?: unknown;
    surgeryId?: unknown;
    predictedAppointmentId?: unknown;
    method?: unknown;
    acknowledgePreviousDecline?: unknown;
  },
): Promise<ConfirmPatientResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'confirmPatient');
  const appointmentId = reqId(input.appointmentId, 'appointment');
  const patientId = reqId(input.patientId, 'patient');
  const practitionerId = reqId(input.practitionerId, 'clinician');
  // Every session belongs to a surgery: the one-session-per-surgery rule and the consent checks depend on it.
  if (input.surgeryId === undefined || input.surgeryId === null || input.surgeryId === '') {
    throw new AppError('VALIDATION', 'Choose the surgery this computer is in before confirming a patient.');
  }
  const surgeryId = reqId(input.surgeryId, 'surgery');
  const predictedAppointmentId = optId(input.predictedAppointmentId, 'predicted appointment');
  const method = reqEnum(input.method, CONFIRMATION_METHODS, 'confirmation method');
  const acknowledgePreviousDecline = optBool(input.acknowledgePreviousDecline, 'acknowledgement');
  await requireClinician(deps, practitionerId);
  const surgery = await requireSurgery(deps, surgeryId);

  const now = deps.clock();
  const tz = deps.clinic.timeZone;
  const appointment = await callDentally(() => deps.dentally.getAppointment(appointmentId));
  if (!appointment) throw new AppError('NOT_FOUND', 'Dentally no longer has that appointment. Refresh the diary.');
  if (appointment.patientId !== patientId) {
    throw new AppError('PATIENT_MISMATCH', 'In Dentally this appointment is no longer booked for that patient. Refresh the diary and check again.');
  }
  if (appointment.practitionerId !== practitionerId) {
    throw new AppError('PRACTITIONER_MISMATCH', 'This appointment is with a different clinician. Select that clinician first.');
  }
  if (!isToday(appointment, now, tz)) throw new AppError('NOT_TODAY', 'That appointment is not today.');
  // Completed and unrecognised states can still be confirmed explicitly (reception sometimes marks an
  // appointment complete while the patient is still in the chair); the state is kept in the session snapshot.
  if (appointment.state === 'Cancelled' || appointment.state === 'Did not attend') {
    throw new AppError('APPOINTMENT_CLOSED', `Dentally shows this appointment as ${appointment.state}.`);
  }
  const patient = await callDentally(() => deps.dentally.getPatient(patientId));
  if (!patient || patient.patientId !== patientId) throw new AppError('NOT_FOUND', 'Dentally could not find this patient.');

  const earlier = await deps.sessions.findByAppointments(ctx.clinicId, [appointmentId]);
  if (earlier.some((s) => s.status === 'CONSENT_DECLINED') && !acknowledgePreviousDecline) {
    throw new AppError('PREVIOUS_DECLINE', 'This patient declined the AI scribe for this appointment earlier. Confirm again only if they have changed their mind.');
  }

  // One open session per surgery, per patient and per clinician (no patient crossover).
  const inSurgery = (await openSessions(ctx, deps, { surgeryId }))[0];
  if (inSurgery) {
    throw new AppError('ACTIVE_SESSION_EXISTS', 'A session is already open in this surgery. Finish or cancel it first.', { sessionId: inSurgery.sessionId });
  }
  const samePatient = (await openSessions(ctx, deps, { patientId }))[0];
  if (samePatient) {
    throw new AppError('DUPLICATE_PATIENT_SESSION', 'This patient already has an open session on another screen.', { sessionId: samePatient.sessionId });
  }
  const forClinician = (await openSessions(ctx, deps, { clinicianId: practitionerId }))[0];
  if (forClinician) {
    throw new AppError('ACTIVE_SESSION_EXISTS', 'This clinician already has an open session, possibly in another surgery. Finish or cancel it first.', {
      sessionId: forClinician.sessionId,
    });
  }

  // The server's own prediction, so near-miss figures do not depend on what the client reports.
  let serverPredictionStatus: 'LIKELY' | 'AMBIGUOUS' | 'NONE' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let serverPredictedAppointmentId: string | null = null;
  try {
    const diary = await deps.dentally.getClinicianAppointments({ date: zonedDateString(now, tz), practitionerId, siteId: deps.clinic.dentallySiteId });
    const todays = diary.appointments.filter((a) => isToday(a, now, tz));
    const done = outcomesFor(await deps.sessions.findByAppointments(ctx.clinicId, todays.map((a) => a.appointmentId)));
    const prediction = predictLikelyPatient({
      nowMs: now,
      practitionerId,
      roomId: surgery?.roomId ?? null,
      appointments: todays,
      excludeAppointmentIds: Object.keys(done),
      options: predictionOptions(deps),
    });
    serverPredictionStatus = prediction.status;
    serverPredictedAppointmentId = prediction.likely?.appointment.appointmentId ?? null;
  } catch {
    // Prediction is for measurement only; the confirmation itself is already verified above.
  }

  const session = createSession({
    sessionId: deps.newId(),
    clinicId: ctx.clinicId,
    clinicianId: practitionerId,
    surgeryId,
    patient: {
      dentallyPatientId: patientId,
      appointment: {
        appointmentId,
        practitionerId: appointment.practitionerId,
        roomId: appointment.roomId,
        startMs: appointment.startMs,
        finishMs: appointment.finishMs,
        reason: appointment.reason,
        stateAtConfirmation: appointment.state,
      },
    },
    method,
    predictedAppointmentId,
    confirmedBy: ctx.email,
    atMs: now,
    clientDeviceId: ctx.deviceId ?? null,
  });
  const ids = { sessionId: session.sessionId, dentallyPatientId: patientId, dentallyAppointmentId: appointmentId };

  // Audit first: a session never exists without its confirmation record.
  await audit(ctx, deps, 'PATIENT_CONFIRMED', {
    ...ids,
    details: {
      method,
      predictedAppointmentId,
      matchedPrediction: session.confirmation.matchedPrediction,
      serverPredictionStatus,
      serverPredictedAppointmentId,
      acknowledgedPreviousDecline: acknowledgePreviousDecline,
      surgeryId,
      practitionerId,
    },
  });
  try {
    await deps.sessions.create(session);
  } catch (err) {
    await withdrawAfterFailedCreate(ctx, deps, session, ids);
    throw err;
  }

  // Two screens can confirm at the same moment. Now that this session is stored, look again: if any other
  // open session conflicts with it, this one is withdrawn. Of two simultaneous confirmations, the one that
  // looks last always sees the other, so at most one survives. (In an exact tie both are withdrawn and
  // the user simply confirms again: no session is safer than two.)
  const rivals = [
    ...(await deps.sessions.findActive(ctx.clinicId, { surgeryId })),
    ...(await deps.sessions.findActive(ctx.clinicId, { patientId })),
    ...(await deps.sessions.findActive(ctx.clinicId, { clinicianId: practitionerId })),
  ].filter((s) => !isTerminal(s.status) && s.sessionId !== session.sessionId);
  if (rivals.length > 0) {
    await applySessionEvent(deps, session, session.version, { type: 'CANCEL', by: SYSTEM_ACTOR.email, atMs: deps.clock() });
    await auditAfterChange(ctx, deps, 'SESSION_CANCELLED', {
      ...ids,
      actor: SYSTEM_ACTOR,
      details: { statusBefore: session.status, reasonCode: 'CONCURRENT_CONFIRMATION' },
    });
    throw new AppError(
      'ACTIVE_SESSION_EXISTS',
      'Another screen confirmed a patient here at the same moment. Check which session is open before confirming again.',
      { sessionId: rivals[0]!.sessionId },
    );
  }

  return { session, patient };
}

/** Records the patient's answer to "may we use the AI scribe today?". A decline ends the session. */
export async function recordConsent(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; given?: unknown; expectedVersion?: unknown; surgeryId?: unknown },
): Promise<SessionResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'recordConsent');
  const sessionId = reqId(input.sessionId, 'session');
  const given = reqBool(input.given, 'answer');
  const expectedVersion = reqInt(input.expectedVersion, 'version');
  const surgeryId = optId(input.surgeryId, 'surgery');
  const before = await loadSession(ctx, deps, sessionId);
  if (!isSessionMember(ctx, before)) {
    await audit(ctx, deps, 'ACCESS_DENIED', { sessionId, details: { operation: 'recordConsent', reasonCode: 'NOT_SESSION_MEMBER' } });
    throw new AppError('FORBIDDEN', 'Only the person who confirmed this patient, or the treating clinician, can record the answer.');
  }
  if (before.surgeryId !== surgeryId) {
    throw new AppError('SURGERY_MISMATCH', 'This session belongs to another surgery. Record the answer there, or cancel the session.');
  }
  if (await expireIfAbandoned(ctx, deps, before)) {
    throw new AppError(
      'SESSION_EXPIRED',
      'This session was left unused after its appointment ended, so it has been closed. Confirm the patient again if they are in the chair.',
    );
  }
  if (!sessionIsToday(before, deps.clock(), deps.clinic.timeZone)) {
    throw new AppError('NOT_TODAY', 'This session is from an earlier day. Cancel it and start a new one.');
  }
  const after = await applySessionEvent(deps, before, expectedVersion, { type: 'RECORD_CONSENT', given, by: ctx.email, atMs: deps.clock() });
  await auditAfterChange(ctx, deps, 'CONSENT_RECORDED', {
    sessionId,
    dentallyPatientId: after.patient.dentallyPatientId,
    dentallyAppointmentId: after.patient.appointment.appointmentId,
    details: { given, statusBefore: before.status },
  });
  return { session: after };
}

/**
 * Cancels a session before anything was recorded (wrong patient, abandoned, another surgery's).
 * Any clinical user or the practice manager may do this: it removes a patient link, it never adds one.
 */
export async function cancelSession(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; expectedVersion?: unknown },
): Promise<SessionResponse> {
  await requireRole(ctx, deps, [...CLINICAL_ROLES, 'CLINIC_ADMIN'], 'cancelSession');
  const sessionId = reqId(input.sessionId, 'session');
  const expectedVersion = reqInt(input.expectedVersion, 'version');
  const before = await loadSession(ctx, deps, sessionId);
  const after = await applySessionEvent(deps, before, expectedVersion, { type: 'CANCEL', by: ctx.email, atMs: deps.clock() });
  await auditAfterChange(ctx, deps, 'SESSION_CANCELLED', {
    sessionId,
    dentallyPatientId: after.patient.dentallyPatientId,
    dentallyAppointmentId: after.patient.appointment.appointmentId,
    details: { statusBefore: before.status, reasonCode: 'USER_CANCELLED' },
  });
  return { session: after };
}

/**
 * The open session for this surgery, or the clinician's open session elsewhere, so a refreshed page
 * restores it with its locked patient and an abandoned one can be found and cancelled. A session this
 * user could not continue here (another surgery, an earlier day, someone else's) comes back with a
 * restriction, and the screen offers only Cancel for it.
 */
export async function getActiveSession(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { surgeryId?: unknown; practitionerId?: unknown },
): Promise<ActiveSessionResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'getActiveSession');
  const surgeryId = optId(input.surgeryId, 'surgery');
  const practitionerId = optId(input.practitionerId, 'clinician');
  if (!surgeryId && !practitionerId) throw new AppError('VALIDATION', 'Give a surgery or a clinician.');
  const inSurgery = surgeryId ? await openSessions(ctx, deps, { surgeryId }) : [];
  const forClinician = practitionerId ? await openSessions(ctx, deps, { clinicianId: practitionerId }) : [];
  const session = inSurgery[0] ?? forClinician[0] ?? null;
  if (!session) return { session: null, restriction: null };
  // Mirrors recordConsent's checks, so the screen never offers an action the server will refuse.
  const restriction: SessionRestriction | null =
    session.surgeryId !== surgeryId
      ? 'OTHER_SURGERY'
      : !sessionIsToday(session, deps.clock(), deps.clinic.timeZone)
        ? 'PREVIOUS_DAY'
        : !isSessionMember(ctx, session)
          ? 'NOT_MEMBER'
          : null;
  return { session, restriction };
}

/** Name and date of birth of the patient locked to a session, looked up by the locked patient ID (never by appointment). */
export async function getSessionPatient(ctx: StaffContext, deps: HandlerDeps, input: { sessionId?: unknown }): Promise<PatientSummary> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'getSessionPatient');
  const sessionId = reqId(input.sessionId, 'session');
  const session = await loadSession(ctx, deps, sessionId);
  const patientId = session.patient.dentallyPatientId;
  const patient = await callDentally(() => deps.dentally.getPatient(patientId));
  if (!patient || patient.patientId !== patientId) throw new AppError('NOT_FOUND', 'Dentally could not find the patient for this session.');
  await audit(ctx, deps, 'PATIENT_VIEWED', {
    sessionId,
    dentallyPatientId: patientId,
    dentallyAppointmentId: session.patient.appointment.appointmentId,
    details: { purpose: 'SESSION_BANNER' },
  });
  return patient;
}

/** Connection status for the header. No patient data. */
export async function getDentallyStatus(ctx: StaffContext, deps: HandlerDeps): Promise<DentallyStatusResponse> {
  await requireRole(ctx, deps, [...CLINICAL_ROLES, 'CLINIC_ADMIN'], 'getDentallyStatus');
  const checkedAt = new Date(deps.clock()).toISOString();
  try {
    const { latencyMs } = await deps.dentally.ping();
    return { status: 'CONNECTED', mode: deps.dentally.mode, latencyMs, checkedAt };
  } catch (err) {
    const auth = err instanceof DentallyError && (err.kind === 'AUTH' || err.kind === 'CONFIG');
    return { status: auth ? 'AUTH_ERROR' : 'UNAVAILABLE', mode: deps.dentally.mode, latencyMs: null, checkedAt };
  }
}
