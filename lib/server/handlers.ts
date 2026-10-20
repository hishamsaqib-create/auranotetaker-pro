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
import type { NoteTemplate } from '../core/noteTemplates.ts';
import { checkTemplate, STARTER_TEMPLATES } from '../core/noteTemplates.ts';
import type { NurseNote, TranscriptSegment } from '../core/transcript.ts';
import { contentDeleteAfterMs, orderSegments, validateNurseNoteText, validateSegments } from '../core/transcript.ts';
import { DentallyError } from '../dentally/client.ts';
import type { PatientSummary, PractitionerSummary, RoomListReport, RoomSummary } from '../dentally/types.ts';
import { ContentCipherError } from './cipher.ts';
import { AppError } from './errors.ts';
import type { AppRole, ClinicianEntry, ClinicianRecord, HandlerDeps, StaffContext, StaffProfileRecord, SurgeryEntry, SurgeryRecord } from './ports.ts';
import type { SpeechToken } from './ports.ts';
import { APP_ROLES, SpeechServiceError, VersionConflictError } from './ports.ts';

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
  /** True when transcripts past their deletion time could not be deleted (decision D2a). Shown, never hidden. */
  retentionCleanupFailed: boolean;
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

export interface ClinicSetupResponse {
  clinicName: string;
  /** Practitioners and rooms as Dentally lists them; null when Dentally could not be reached. No patient data. */
  dentally: { practitioners: PractitionerSummary[]; rooms: RoomSummary[] } | null;
  dentallyError: string | null;
  /** How Dentally's room list was read, for the setup screen when no rooms appear. Room data only, never patients. */
  roomsReport: Omit<RoomListReport, 'rooms'> | null;
  clinicians: ClinicianRecord[];
  surgeries: SurgeryRecord[];
  staff: StaffProfileRecord[];
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

function reqCount(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
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
    // Every surgery screen refreshes its diary through the day, so expired transcripts go promptly.
    retentionCleanupFailed: !(await purgeExpiredContent(ctx, deps)),
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
  // Decision D7: a decline or withdrawal means nothing from this appointment is kept or processed.
  if (!given) await deleteSessionContent(ctx, deps, after, 'CONSENT_WITHDRAWN');
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
  // Nurse notes can be typed before recording starts; a cancelled session keeps none of them.
  await deleteSessionContent(ctx, deps, after, 'SESSION_CANCELLED');
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

export interface DentallyCheckResponse {
  date: string;
  /** Today's appointments in Dentally across all practitioners, counted by ID. No patient data. */
  total: number;
  rejected: number;
  byPractitioner: Record<string, number>;
  byRoom: Record<string, number>;
  /** Dentally practitioners with their linked user IDs, to match against the diary. */
  practitioners: { practitionerId: string; userId: string | null; displayName: string; active: boolean }[];
}

/**
 * Setup check for the practice manager: which practitioner and room IDs today's Dentally diary uses, so the
 * clinicians and surgeries in AuraNoteTaker can be matched to them. Counts and IDs only, never patients.
 */
export async function getDentallyCheck(ctx: StaffContext, deps: HandlerDeps): Promise<DentallyCheckResponse> {
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'getDentallyCheck');
  const date = zonedDateString(deps.clock(), deps.clinic.timeZone);
  const [diary, practitioners] = await callDentally(() =>
    Promise.all([deps.dentally.getTodaysAppointments({ date, siteId: deps.clinic.dentallySiteId }), deps.dentally.listPractitioners()]),
  );
  const byPractitioner: Record<string, number> = {};
  const byRoom: Record<string, number> = {};
  for (const a of diary.appointments) {
    byPractitioner[a.practitionerId] = (byPractitioner[a.practitionerId] ?? 0) + 1;
    const room = a.roomId ?? 'none';
    byRoom[room] = (byRoom[room] ?? 0) + 1;
  }
  return { date, total: diary.appointments.length, rejected: diary.rejectedCount, byPractitioner, byRoom, practitioners };
}

// ---------------------------------------------------------------------------
// Note templates and copied notes. Templates hold no patient data. A finished note is written in the browser
// and copied into Dentally by the clinician; AuraNoteTaker does not store it and never writes to Dentally.

export interface NoteTemplatesResponse {
  /** The clinic's own templates first (active ones only unless asked), then the starters. */
  templates: NoteTemplate[];
}

const TEMPLATE_ROLES: readonly AppRole[] = [...CLINICAL_ROLES, 'CLINIC_ADMIN'];

export async function listNoteTemplates(ctx: StaffContext, deps: HandlerDeps, input: { includeInactive?: unknown } = {}): Promise<NoteTemplatesResponse> {
  await requireRole(ctx, deps, TEMPLATE_ROLES, 'listNoteTemplates');
  const includeInactive = optBool(input.includeInactive, 'includeInactive');
  const own = (await deps.admin.listNoteTemplates(deps.clinic.clinicId))
    .filter((t) => includeInactive || t.active)
    .sort((a, b) => a.title.localeCompare(b.title, 'en-GB'));
  return { templates: [...own, ...STARTER_TEMPLATES.map((t) => ({ ...t }))] };
}

/** Practice manager: creates (no templateId) or updates one of the clinic's templates. Starters cannot be changed, only copied. */
export async function saveNoteTemplate(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { templateId?: unknown; title?: unknown; body?: unknown; active?: unknown },
): Promise<NoteTemplatesResponse & { templateId: string }> {
  // The clinic's wording for clinical records: changed by the practice manager, used by everyone.
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'saveNoteTemplate');
  const templateId = optId(input.templateId, 'template');
  if (templateId && STARTER_TEMPLATES.some((t) => t.templateId === templateId)) {
    throw new AppError('VALIDATION', 'Starter templates cannot be changed. Make your own copy instead.');
  }
  const checked = checkTemplate(input.title, input.body);
  if (!checked.ok) throw new AppError('VALIDATION', checked.message);
  const active = input.active === undefined ? true : reqBool(input.active, 'active');
  const existing = await deps.admin.listNoteTemplates(deps.clinic.clinicId);
  if (templateId && !existing.some((t) => t.templateId === templateId)) {
    throw new AppError('NOT_FOUND', 'That template no longer exists. Refresh the page.');
  }
  if (existing.some((t) => t.templateId !== templateId && t.active && t.title.toLowerCase() === checked.title.toLowerCase())) {
    throw new AppError('VALIDATION', `There is already a template called ${checked.title}.`);
  }
  const savedId = await deps.admin.saveNoteTemplate(deps.clinic.clinicId, {
    templateId,
    title: checked.title,
    body: checked.body,
    active,
    updatedBy: ctx.email,
    updatedAtMs: deps.clock(),
  });
  await auditAfterChange(ctx, deps, 'CONFIG_CHANGED', {
    details: { entity: 'NOTE_TEMPLATE', change: templateId ? 'UPDATED' : 'CREATED', count: 1 },
  });
  return { ...(await listNoteTemplates(ctx, deps, { includeInactive: true })), templateId: savedId };
}

/**
 * Records that a finished note was copied for Dentally, for the audit trail. With a session, the session's
 * locked patient is recorded (by ID); the note text never is.
 */
export async function recordNoteCopied(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; templateId?: unknown; unfilledCount?: unknown },
): Promise<{ recorded: true }> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'recordNoteCopied');
  const templateId = optId(input.templateId, 'template');
  const unfilledCount = reqCount(input.unfilledCount, 'unfilled count');
  const sessionId = optId(input.sessionId, 'session');
  const session = sessionId ? await loadSession(ctx, deps, sessionId) : null;
  if (session && !isSessionMember(ctx, session)) {
    await audit(ctx, deps, 'ACCESS_DENIED', { sessionId, details: { operation: 'recordNoteCopied', reasonCode: 'NOT_SESSION_MEMBER' } });
    throw new AppError('FORBIDDEN', 'Only the person who confirmed this patient, or the treating clinician, can write their note here.');
  }
  // A note against a session is for today's patient in a session still in use (or one the patient declined).
  if (session && ((isTerminal(session.status) && session.status !== 'CONSENT_DECLINED') || !sessionIsToday(session, deps.clock(), deps.clinic.timeZone))) {
    throw new AppError('SESSION_TRANSITION_REFUSED', 'This session is closed or from an earlier day. Write the note from "Write a note" and check the patient in Dentally.');
  }
  await audit(ctx, deps, 'NOTE_COPIED', {
    sessionId: session?.sessionId ?? null,
    dentallyPatientId: session?.patient.dentallyPatientId ?? null,
    dentallyAppointmentId: session?.patient.appointment.appointmentId ?? null,
    details: { templateId, unfilledCount, source: session ? 'SESSION' : 'STANDALONE' },
  });
  return { recorded: true };
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

// ---------------------------------------------------------------------------
// Scribe capture (Phase 2): recording controls, speech-to-text tokens, transcript and nurse notes.
//
// SAFETY (hazards H02, H03, H12):
// - Nothing is captured until the patient's permission is recorded (the session state machine refuses it),
//   and transcript is only accepted for a session that is recording, paused or just stopped.
// - Only the session's members, at the surgery the session belongs to, can record or add content.
// - Transcript and nurse notes are encrypted and kept only until the end of the next day (decision D2a).
//   A decline, withdrawal or cancellation deletes them at once (decision D7).
// - Audit events record what happened and how many records, never the text.

export type RecordingAction = 'START' | 'PAUSE' | 'RESUME' | 'STOP';
const RECORDING_ACTIONS: readonly RecordingAction[] = ['START', 'PAUSE', 'RESUME', 'STOP'];
const RECORDING_EVENT: Record<RecordingAction, 'START_RECORDING' | 'PAUSE' | 'RESUME' | 'STOP'> = {
  START: 'START_RECORDING',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
};

export interface RecordingResponse extends SessionResponse {
  /** Set when old transcripts past their deletion time could not be deleted. Recording still works. */
  warning: 'RETENTION_CLEANUP_FAILED' | null;
}

export type SpeechTokenResponse = SpeechToken;

export interface ScribeContentResponse {
  segments: TranscriptSegment[];
  nurseNote: NurseNote | null;
}

export interface SaveTranscriptResponse {
  /** Segments newly stored by this save (a retried save stores nothing twice). */
  saved: number;
}

export interface NurseNoteResponse {
  nurseNote: NurseNote;
}

const ACCEPTS_TRANSCRIPT = new Set<ScribeSession['status']>(['RECORDING', 'PAUSED', 'STOPPED']);
const ACCEPTS_NURSE_NOTES = new Set<ScribeSession['status']>(['READY', 'RECORDING', 'PAUSED', 'STOPPED']);
const PURGE_BATCH = 5_000;
export const CONTENT_VIEW_AUDIT_WINDOW_MS = 15 * 60_000;

const segmentContext = (clinicId: string, sessionId: string, segmentId: string) => `transcript:${clinicId}:${sessionId}:${segmentId}`;
const nurseNoteContext = (clinicId: string, sessionId: string) => `nurse-note:${clinicId}:${sessionId}`;

/** Loads a session for scribe work: right role, a member of the session, at the session's surgery. */
async function loadScribeSession(ctx: StaffContext, deps: HandlerDeps, input: { sessionId?: unknown; surgeryId?: unknown }, operation: string) {
  await requireRole(ctx, deps, CLINICAL_ROLES, operation);
  const sessionId = reqId(input.sessionId, 'session');
  const surgeryId = optId(input.surgeryId, 'surgery');
  const session = await loadSession(ctx, deps, sessionId);
  if (!isSessionMember(ctx, session)) {
    await audit(ctx, deps, 'ACCESS_DENIED', { sessionId, details: { operation, reasonCode: 'NOT_SESSION_MEMBER' } });
    throw new AppError('FORBIDDEN', 'Only the person who confirmed this patient, or the treating clinician, can use this session.');
  }
  if (session.surgeryId !== surgeryId) {
    throw new AppError('SURGERY_MISMATCH', 'This session belongs to another surgery. Continue it there.');
  }
  return session;
}

async function getCipher(deps: HandlerDeps) {
  try {
    return await deps.cipher();
  } catch {
    throw new AppError('INTERNAL', 'AuraNoteTaker is not fully configured for recording. Please tell the practice manager.');
  }
}

async function deleteSessionContent(ctx: StaffContext, deps: HandlerDeps, s: ScribeSession, reasonCode: string): Promise<void> {
  let count: number;
  try {
    count = await deps.content.deleteSession(ctx.clinicId, s.sessionId);
  } catch {
    throw new AppError(
      'INTERNAL',
      'The session was closed, but its transcript or nurse notes could not be deleted. Please tell the practice manager today.',
    );
  }
  if (count > 0) {
    await auditAfterChange(ctx, deps, 'SCRIBE_CONTENT_DELETED', {
      sessionId: s.sessionId,
      dentallyPatientId: s.patient.dentallyPatientId,
      dentallyAppointmentId: s.patient.appointment.appointmentId,
      details: { reasonCode, count },
    });
  }
}

/** Deletes content past its time. Returns false when that failed, so the screen can say so. */
async function purgeExpiredContent(ctx: StaffContext, deps: HandlerDeps): Promise<boolean> {
  try {
    const count = await deps.content.purgeExpired(ctx.clinicId, deps.clock(), PURGE_BATCH);
    if (count > 0) {
      await audit(ctx, deps, 'SCRIBE_CONTENT_DELETED', { actor: SYSTEM_ACTOR, details: { reasonCode: 'RETENTION_EXPIRED', count } });
    }
    return true;
  } catch {
    return false;
  }
}

/** Start, pause, resume or stop recording. Starting or resuming needs a session from today. */
export async function changeRecording(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; surgeryId?: unknown; action?: unknown; expectedVersion?: unknown },
): Promise<RecordingResponse> {
  const action = reqEnum(input.action, RECORDING_ACTIONS, 'action');
  const expectedVersion = reqInt(input.expectedVersion, 'version');
  const before = await loadScribeSession(ctx, deps, input, 'changeRecording');
  if (action === 'START' || action === 'RESUME') {
    if (await expireIfAbandoned(ctx, deps, before)) {
      throw new AppError(
        'SESSION_EXPIRED',
        'This session was left unused after its appointment ended, so it has been closed. Confirm the patient again if they are in the chair.',
      );
    }
    if (!sessionIsToday(before, deps.clock(), deps.clinic.timeZone)) {
      throw new AppError('NOT_TODAY', 'This session is from an earlier day and cannot record. Start a new one.');
    }
  }
  const after = await applySessionEvent(deps, before, expectedVersion, { type: RECORDING_EVENT[action], by: ctx.email, atMs: deps.clock() });
  await auditAfterChange(ctx, deps, 'SESSION_STATUS_CHANGED', {
    sessionId: after.sessionId,
    dentallyPatientId: after.patient.dentallyPatientId,
    dentallyAppointmentId: after.patient.appointment.appointmentId,
    details: { from: before.status, to: after.status, reasonCode: `USER_${action}` },
  });
  const cleaned = action === 'START' ? await purgeExpiredContent(ctx, deps) : true;
  return { session: after, warning: cleaned ? null : 'RETENTION_CLEANUP_FAILED' };
}

/** A short-lived token for streaming this session's audio to speech-to-text. Only while recording. */
export async function getSpeechToken(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; surgeryId?: unknown },
): Promise<SpeechTokenResponse> {
  const s = await loadScribeSession(ctx, deps, input, 'getSpeechToken');
  if (s.status !== 'RECORDING' || s.consent.status !== 'GIVEN') {
    throw new AppError('SESSION_TRANSITION_REFUSED', 'This session is not recording.');
  }
  if (!sessionIsToday(s, deps.clock(), deps.clinic.timeZone)) {
    throw new AppError('NOT_TODAY', 'This session is from an earlier day and cannot record.');
  }
  await audit(ctx, deps, 'SPEECH_TOKEN_ISSUED', {
    sessionId: s.sessionId,
    dentallyPatientId: s.patient.dentallyPatientId,
    dentallyAppointmentId: s.patient.appointment.appointmentId,
    details: { provider: deps.speech.provider },
  });
  try {
    return await deps.speech.issue();
  } catch (err) {
    if (err instanceof SpeechServiceError && err.kind !== 'UNAVAILABLE') {
      throw new AppError('SPEECH_NOT_CONFIGURED', 'AuraNoteTaker could not sign in to the speech-to-text service. Please tell the practice manager.');
    }
    throw new AppError('SPEECH_UNAVAILABLE', 'The speech-to-text service is not responding. Nurse notes still work; try recording again shortly.');
  }
}

/** Stores finished transcript segments (encrypted). Retries are safe: a segment ID is stored once. */
export async function saveTranscript(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; surgeryId?: unknown; segments?: unknown },
): Promise<SaveTranscriptResponse> {
  const s = await loadScribeSession(ctx, deps, input, 'saveTranscript');
  if (!ACCEPTS_TRANSCRIPT.has(s.status) || s.consent.status !== 'GIVEN') {
    throw new AppError('SESSION_TRANSITION_REFUSED', 'This session is not recording, so the transcript was not saved.');
  }
  const checked = validateSegments(input.segments);
  if (!checked.ok) throw new AppError('VALIDATION', checked.message);
  const cipher = await getCipher(deps);
  const now = deps.clock();
  const deleteAfterMs = contentDeleteAfterMs(now, deps.clinic.timeZone);
  const stored = await Promise.all(
    checked.value.map(async (seg) => ({
      kind: seg.kind,
      segmentId: seg.segmentId,
      seq: seg.seq,
      startMs: seg.startMs,
      endMs: seg.endMs,
      speaker: seg.speaker,
      cipherText: await cipher.encrypt(seg.text, segmentContext(ctx.clinicId, s.sessionId, seg.segmentId)),
      capturedBy: ctx.email,
      savedAtMs: now,
      deleteAfterMs,
    })),
  );
  const saved = await deps.content.addSegments(ctx.clinicId, s.sessionId, stored);
  await deleteIfPermissionEnded(ctx, deps, s.sessionId);
  return { saved };
}

/**
 * A save can race a withdrawal: the save checked permission, then the withdrawal deleted the session's
 * content, then the save wrote its rows. So after writing, check again and delete if permission has ended.
 */
async function deleteIfPermissionEnded(ctx: StaffContext, deps: HandlerDeps, sessionId: string): Promise<void> {
  const now = await loadSession(ctx, deps, sessionId);
  if (now.consent.status === 'GIVEN' && !isTerminal(now.status)) return;
  await deleteSessionContent(ctx, deps, now, now.consent.status === 'GIVEN' ? 'SESSION_CLOSED' : 'CONSENT_WITHDRAWN');
  throw new AppError('SESSION_TRANSITION_REFUSED', 'Permission for this appointment has ended, so nothing more is kept.');
}

/** The session's transcript and nurse notes so far, for the scribe screen after a refresh. */
export async function getScribeContent(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; surgeryId?: unknown },
): Promise<ScribeContentResponse> {
  const s = await loadScribeSession(ctx, deps, input, 'getScribeContent');
  if (s.consent.status !== 'GIVEN' || isTerminal(s.status)) return { segments: [], nurseNote: null };
  const cipher = await getCipher(deps);
  let segments: TranscriptSegment[];
  let nurseNote: NurseNote | null;
  try {
    segments = orderSegments(
      await Promise.all(
        (await deps.content.listSegments(ctx.clinicId, s.sessionId)).map(async (r) => ({
          kind: r.kind,
          segmentId: r.segmentId,
          seq: r.seq,
          startMs: r.startMs,
          endMs: r.endMs,
          speaker: r.speaker,
          text: await cipher.decrypt(r.cipherText, segmentContext(ctx.clinicId, s.sessionId, r.segmentId)),
          capturedBy: r.capturedBy,
          savedAtMs: r.savedAtMs,
        })),
      ),
    );
    const note = await deps.content.getNurseNote(ctx.clinicId, s.sessionId);
    nurseNote = note
      ? {
          text: await cipher.decrypt(note.cipherText, nurseNoteContext(ctx.clinicId, s.sessionId)),
          revision: note.revision,
          updatedBy: note.updatedBy,
          updatedAtMs: note.updatedAtMs,
        }
      : null;
  } catch (err) {
    if (err instanceof ContentCipherError) {
      throw new AppError('CONTENT_UNREADABLE', 'The transcript for this session could not be read. Please tell the practice manager.');
    }
    throw err;
  }
  const dedupeKey = `content:${s.sessionId}`;
  if (!(await deps.audit.hasRecent(ctx.clinicId, ctx.email, dedupeKey, deps.clock() - CONTENT_VIEW_AUDIT_WINDOW_MS))) {
    await audit(ctx, deps, 'SCRIBE_CONTENT_VIEWED', {
      sessionId: s.sessionId,
      dentallyPatientId: s.patient.dentallyPatientId,
      dentallyAppointmentId: s.patient.appointment.appointmentId,
      details: { purpose: 'RESTORE', segmentCount: segments.length, hasNurseNote: nurseNote !== null },
      dedupeKey,
    });
  }
  return { segments, nurseNote };
}

/** Saves the nurse notes. `expectedRevision` is the revision the screen edited (0 for the first save). */
export async function saveNurseNote(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; surgeryId?: unknown; text?: unknown; expectedRevision?: unknown },
): Promise<NurseNoteResponse> {
  const s = await loadScribeSession(ctx, deps, input, 'saveNurseNote');
  if (!ACCEPTS_NURSE_NOTES.has(s.status) || s.consent.status !== 'GIVEN') {
    throw new AppError('SESSION_TRANSITION_REFUSED', 'Nurse notes cannot be changed for this session now.');
  }
  const checked = validateNurseNoteText(input.text);
  if (!checked.ok) throw new AppError('VALIDATION', checked.message);
  const expectedRevision = reqCount(input.expectedRevision, 'revision');
  const cipher = await getCipher(deps);
  const now = deps.clock();
  const note: NurseNote = { text: checked.value, revision: expectedRevision + 1, updatedBy: ctx.email, updatedAtMs: now };
  try {
    await deps.content.saveNurseNote(
      ctx.clinicId,
      s.sessionId,
      {
        cipherText: await cipher.encrypt(note.text, nurseNoteContext(ctx.clinicId, s.sessionId)),
        revision: note.revision,
        updatedBy: note.updatedBy,
        updatedAtMs: note.updatedAtMs,
        deleteAfterMs: contentDeleteAfterMs(now, deps.clinic.timeZone),
      },
      expectedRevision,
    );
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new AppError('VERSION_CONFLICT', 'The nurse notes were changed on another screen. Load the latest notes before typing more.');
    }
    throw err;
  }
  await deleteIfPermissionEnded(ctx, deps, s.sessionId);
  return { nurseNote: note };
}

// ---------------------------------------------------------------------------
// Clinic setup (practice manager). Configuration only: no patient data is read or written here.

/** Roles a practice manager can grant. SUPER_ADMIN is a platform role and is never granted from a clinic. */
export const GRANTABLE_ROLES: readonly AppRole[] = ['CLINIC_ADMIN', 'DENTIST', 'THERAPIST', 'HYGIENIST', 'NURSE', 'AUDITOR'];
const CLINICIAN_TYPES: readonly ClinicianEntry['clinicianType'][] = ['DENTIST', 'THERAPIST', 'HYGIENIST', 'OTHER'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

function reqName(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  const name = v.trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return name;
}

function reqList(v: unknown, field: string, max = 200): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new AppError('VALIDATION', `Missing or invalid ${field}.`);
  return v;
}

async function clinicSetup(deps: HandlerDeps): Promise<ClinicSetupResponse> {
  const clinicId = deps.clinic.clinicId;
  let dentally: ClinicSetupResponse['dentally'] = null;
  let dentallyError: string | null = null;
  let roomsReport: ClinicSetupResponse['roomsReport'] = null;
  try {
    const [practitioners, report] = await callDentally(() => Promise.all([deps.dentally.listPractitioners(), deps.dentally.listRoomsWithReport()]));
    const { rooms, ...rest } = report;
    dentally = { practitioners, rooms };
    roomsReport = rest;
  } catch (err) {
    // Staff can still be managed while Dentally is down; clinicians and surgeries cannot be added.
    if (!(err instanceof AppError)) throw err;
    dentallyError = err.message;
  }
  const [clinicians, surgeries, staff] = await Promise.all([
    deps.admin.listClinicianRecords(clinicId),
    deps.admin.listSurgeryRecords(clinicId),
    deps.admin.listStaff(clinicId),
  ]);
  return { clinicName: deps.clinic.name, dentally, dentallyError, roomsReport, clinicians, surgeries, staff };
}

/** Everything the setup screen shows: Dentally's practitioners and rooms, and what is configured. */
export async function getClinicSetup(ctx: StaffContext, deps: HandlerDeps): Promise<ClinicSetupResponse> {
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'getClinicSetup');
  return clinicSetup(deps);
}

/**
 * Chooses which Dentally practitioners are clinicians in AuraNoteTaker. Names come from Dentally, and
 * every practitioner is checked against Dentally's own list, so a made-up ID cannot be configured.
 */
export async function saveClinicians(ctx: StaffContext, deps: HandlerDeps, input: { clinicians?: unknown }): Promise<ClinicSetupResponse> {
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'saveClinicians');
  const items = reqList(input.clinicians, 'clinicians').map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      practitionerId: reqId(r.practitionerId, 'clinician'),
      clinicianType: reqEnum(r.clinicianType, CLINICIAN_TYPES, 'clinician type'),
      active: reqBool(r.active, 'active'),
    };
  });
  const known = new Map((await callDentally(() => deps.dentally.listPractitioners())).map((p) => [p.practitionerId, p]));
  const records: ClinicianRecord[] = items.map((i) => {
    const p = known.get(i.practitionerId);
    if (!p) throw new AppError('VALIDATION', 'One of those clinicians is not in Dentally. Refresh the page and try again.');
    return { practitionerId: p.practitionerId, displayName: p.displayName, clinicianType: i.clinicianType, dentallyUserId: p.userId, active: i.active };
  });
  await deps.admin.saveClinicianRecords(deps.clinic.clinicId, records);
  await auditAfterChange(ctx, deps, 'CONFIG_CHANGED', { details: { entity: 'CLINICIAN', change: 'SAVED', count: records.length } });
  return clinicSetup(deps);
}

/** Chooses which Dentally rooms are surgeries in AuraNoteTaker, checked against Dentally's own list. */
export async function saveSurgeries(ctx: StaffContext, deps: HandlerDeps, input: { surgeries?: unknown }): Promise<ClinicSetupResponse> {
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'saveSurgeries');
  const raw = reqList(input.surgeries, 'surgeries').map((x) => (x ?? {}) as Record<string, unknown>);
  const existing = await deps.admin.listSurgeryRecords(deps.clinic.clinicId);
  const needsDentally = raw.some((r) => r.roomId !== undefined && r.roomId !== null);
  const known = needsDentally ? new Map((await callDentally(() => deps.dentally.listRooms())).map((room) => [room.roomId, room])) : new Map();
  const records = raw.map((r) => {
    const active = reqBool(r.active, 'active');
    if (r.roomId !== undefined && r.roomId !== null) {
      // A Dentally room: its name always comes from Dentally.
      const room = known.get(reqId(r.roomId, 'room'));
      if (!room) throw new AppError('VALIDATION', 'One of those surgeries is not in Dentally. Refresh the page and try again.');
      return { roomId: room.roomId, name: room.name, active };
    }
    // A surgery named here, for when Dentally lists no rooms. It is not linked to a Dentally room.
    const name = reqName(r.name, 'surgery name');
    const surgeryId = optId(r.surgeryId, 'surgery');
    if (surgeryId && !existing.some((x) => x.surgeryId === surgeryId && x.roomId === null)) {
      throw new AppError('VALIDATION', 'That surgery no longer exists. Refresh the page.');
    }
    if (!surgeryId && existing.some((x) => x.roomId === null && x.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('VALIDATION', `There is already a surgery called ${name}.`);
    }
    return { surgeryId, roomId: null, name, active };
  });
  await deps.admin.saveSurgeryRecords(deps.clinic.clinicId, records);
  await auditAfterChange(ctx, deps, 'CONFIG_CHANGED', { details: { entity: 'SURGERY', change: 'SAVED', count: records.length } });
  return clinicSetup(deps);
}

export async function saveStaffProfile(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { email?: unknown; displayName?: unknown; roles?: unknown; clinicianId?: unknown; active?: unknown },
): Promise<ClinicSetupResponse> {
  await requireRole(ctx, deps, ['CLINIC_ADMIN'], 'saveStaffProfile');
  if (typeof input.email !== 'string' || !EMAIL.test(input.email.trim())) throw new AppError('VALIDATION', 'Enter a valid email address.');
  const email = input.email.trim().toLowerCase();
  const displayName = reqName(input.displayName, 'name');
  const roles = [...new Set(reqList(input.roles, 'roles', GRANTABLE_ROLES.length).map((r) => reqEnum(r, GRANTABLE_ROLES, 'role')))];
  if (roles.length === 0) throw new AppError('VALIDATION', 'Choose at least one role.');
  const active = reqBool(input.active, 'active');
  const clinicianId = optId(input.clinicianId, 'clinician');
  if (clinicianId !== null && !(await deps.directory.listClinicians(deps.clinic.clinicId)).some((c) => c.practitionerId === clinicianId)) {
    throw new AppError('VALIDATION', 'That clinician is not set up in AuraNoteTaker.');
  }

  const staff = await deps.admin.listStaff(deps.clinic.clinicId);
  const before = staff.find((x) => x.email === email);
  const record: StaffProfileRecord = { email, displayName, roles, clinicianId, active };
  const after = [...staff.filter((x) => x.email !== email), record];
  if (!after.some((x) => x.active && x.roles.includes('CLINIC_ADMIN'))) {
    throw new AppError('VALIDATION', 'At least one active practice manager must keep access to setup.');
  }
  await deps.admin.saveStaff(deps.clinic.clinicId, record);
  await auditAfterChange(ctx, deps, 'CONFIG_CHANGED', {
    details: { entity: 'STAFF_PROFILE', change: before ? 'UPDATED' : 'CREATED', count: 1 },
  });
  return clinicSetup(deps);
}
