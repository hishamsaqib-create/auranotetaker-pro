// Server handlers: the only path through which the web app reads the diary, confirms a
// patient or changes a session. Pure functions of (caller context, injected dependencies, input).
//
// SAFETY: every handler re-checks what the client claims. The caller's clinic and roles come
// from StaffContext (resolved server-side), never from input. Confirming a patient re-fetches
// the appointment from Dentally and refuses on any mismatch (hazards H01, H17, H18).

import type { DiaryAppointment, DiaryAppointmentDto } from '../core/appointments.ts';
import { toDiaryDto } from '../core/appointments.ts';
import type { AuditAction } from '../core/audit.ts';
import { buildAuditEvent } from '../core/audit.ts';
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

export interface DiaryResponse {
  date: string;
  timeZone: string;
  fetchedAt: string;
  practitionerId: string;
  appointments: DiaryAppointmentDto[];
  rejectedCount: number;
}

export interface PatientSummaryResponse extends PatientSummary {
  appointmentId: string;
}

export interface SessionResponse {
  session: ScribeSession;
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

async function audit(
  ctx: StaffContext,
  deps: HandlerDeps,
  action: AuditAction,
  extra: { sessionId?: string | null; dentallyPatientId?: string | null; dentallyAppointmentId?: string | null; details?: Record<string, unknown> } = {},
): Promise<void> {
  await deps.audit.append(
    buildAuditEvent({
      clinicId: ctx.clinicId,
      occurredAtMs: deps.clock(),
      actorEmail: ctx.email,
      actorRoles: ctx.roles,
      action,
      ...extra,
      client: { deviceId: ctx.deviceId ?? null, appVersion: ctx.appVersion ?? null },
    }),
  );
}

async function requireRole(ctx: StaffContext, deps: HandlerDeps, roles: readonly AppRole[], operation: string): Promise<void> {
  if (ctx.clinicId !== deps.clinic.clinicId) {
    await audit(ctx, deps, 'ACCESS_DENIED', { details: { operation, reasonCode: 'CLINIC' } });
    throw new AppError('FORBIDDEN', 'You do not have access to this clinic.');
  }
  if (!ctx.roles.some((r) => roles.includes(r))) {
    await audit(ctx, deps, 'ACCESS_DENIED', { details: { operation, reasonCode: 'ROLE' } });
    throw new AppError('FORBIDDEN', 'Your role does not allow this.');
  }
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

function isToday(a: DiaryAppointment, nowMs: number, timeZone: string): boolean {
  const today = zonedDateString(nowMs, timeZone);
  return zonedDateString(a.startMs, timeZone) === today || zonedDateString(a.finishMs, timeZone) === today;
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

async function applySessionEvent(
  ctx: StaffContext,
  deps: HandlerDeps,
  sessionId: string,
  expectedVersion: number,
  event: SessionEvent,
): Promise<{ before: ScribeSession; after: ScribeSession }> {
  const before = await loadSession(ctx, deps, sessionId);
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
  return { before, after: result.session };
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
  const reason = input.reason === undefined ? 'INITIAL' : reqEnum(input.reason, DIARY_REASONS, 'reason');
  await requireClinician(deps, practitionerId);

  const now = deps.clock();
  const date = zonedDateString(now, deps.clinic.timeZone);
  const result = await callDentally(() =>
    deps.dentally.getClinicianAppointments({ date, practitionerId, siteId: deps.clinic.dentallySiteId }),
  );
  const appointments = result.appointments
    .filter((a) => a.practitionerId === practitionerId && isToday(a, now, deps.clinic.timeZone))
    .sort((x, y) => x.startMs - y.startMs || (x.appointmentId < y.appointmentId ? -1 : 1));

  // Background refreshes are not audited individually; first load and manual refreshes are.
  if (reason !== 'REFRESH') {
    await audit(ctx, deps, 'DIARY_VIEWED', {
      details: { date, practitionerId, appointmentCount: appointments.length, rejectedCount: result.rejectedCount },
    });
  }
  return {
    date,
    timeZone: deps.clinic.timeZone,
    fetchedAt: new Date(now).toISOString(),
    practitionerId,
    appointments: appointments.map(toDiaryDto),
    rejectedCount: result.rejectedCount,
  };
}

/**
 * Name and date of birth for the patient booked in one of today's appointments, for the
 * identity check on the confirm card. Takes an appointment, not a patient ID, so the
 * scribe cannot be used to look up arbitrary patients.
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
  },
): Promise<SessionResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'confirmPatient');
  const appointmentId = reqId(input.appointmentId, 'appointment');
  const patientId = reqId(input.patientId, 'patient');
  const practitionerId = reqId(input.practitionerId, 'clinician');
  const surgeryId = optId(input.surgeryId, 'surgery');
  const predictedAppointmentId = optId(input.predictedAppointmentId, 'predicted appointment');
  const method = reqEnum(input.method, CONFIRMATION_METHODS, 'confirmation method');
  await requireClinician(deps, practitionerId);
  await requireSurgery(deps, surgeryId);

  const now = deps.clock();
  const appointment = await callDentally(() => deps.dentally.getAppointment(appointmentId));
  if (!appointment) throw new AppError('NOT_FOUND', 'Dentally no longer has that appointment. Refresh the diary.');
  if (appointment.patientId !== patientId) {
    throw new AppError('PATIENT_MISMATCH', 'In Dentally this appointment is no longer booked for that patient. Refresh the diary and check again.');
  }
  if (appointment.practitionerId !== practitionerId) {
    throw new AppError('PRACTITIONER_MISMATCH', 'This appointment is with a different clinician. Select that clinician first.');
  }
  if (!isToday(appointment, now, deps.clinic.timeZone)) throw new AppError('NOT_TODAY', 'That appointment is not today.');
  if (appointment.state === 'Cancelled' || appointment.state === 'Did not attend') {
    throw new AppError('APPOINTMENT_CLOSED', `Dentally shows this appointment as ${appointment.state}.`);
  }

  // One open session per surgery and per clinician: a clinician who moved surgery, or forgot to finish,
  // must close the earlier session before starting another (no patient crossover).
  const inSurgery = surgeryId ? (await deps.sessions.findActive(ctx.clinicId, { surgeryId }))[0] : undefined;
  if (inSurgery) {
    throw new AppError('ACTIVE_SESSION_EXISTS', 'A session is already open in this surgery. Finish or cancel it first.', {
      sessionId: inSurgery.sessionId,
    });
  }
  const samePatient = (await deps.sessions.findActive(ctx.clinicId, { patientId }))[0];
  if (samePatient) {
    throw new AppError('DUPLICATE_PATIENT_SESSION', 'This patient already has an open session on another screen.', { sessionId: samePatient.sessionId });
  }
  const forClinician = (await deps.sessions.findActive(ctx.clinicId, { clinicianId: practitionerId }))[0];
  if (forClinician) {
    throw new AppError('ACTIVE_SESSION_EXISTS', 'This clinician already has an open session, possibly in another surgery. Finish or cancel it first.', {
      sessionId: forClinician.sessionId,
    });
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
  await deps.sessions.create(session);
  await audit(ctx, deps, 'PATIENT_CONFIRMED', {
    sessionId: session.sessionId,
    dentallyPatientId: patientId,
    dentallyAppointmentId: appointmentId,
    details: {
      method,
      predictedAppointmentId,
      matchedPrediction: session.confirmation.matchedPrediction,
      surgeryId,
      practitionerId,
    },
  });
  return { session };
}

/** Records the patient's answer to "may we use the AI scribe today?". A decline ends the session. */
export async function recordConsent(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; given?: unknown; expectedVersion?: unknown },
): Promise<SessionResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'recordConsent');
  const sessionId = reqId(input.sessionId, 'session');
  const given = reqBool(input.given, 'answer');
  const expectedVersion = reqInt(input.expectedVersion, 'version');
  const { before, after } = await applySessionEvent(ctx, deps, sessionId, expectedVersion, {
    type: 'RECORD_CONSENT',
    given,
    by: ctx.email,
    atMs: deps.clock(),
  });
  await audit(ctx, deps, 'CONSENT_RECORDED', {
    sessionId,
    dentallyPatientId: after.patient.dentallyPatientId,
    dentallyAppointmentId: after.patient.appointment.appointmentId,
    details: { given, statusBefore: before.status },
  });
  return { session: after };
}

/** Cancels a session before anything was recorded (for example the wrong patient was confirmed). */
export async function cancelSession(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { sessionId?: unknown; expectedVersion?: unknown },
): Promise<SessionResponse> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'cancelSession');
  const sessionId = reqId(input.sessionId, 'session');
  const expectedVersion = reqInt(input.expectedVersion, 'version');
  const { before, after } = await applySessionEvent(ctx, deps, sessionId, expectedVersion, {
    type: 'CANCEL',
    by: ctx.email,
    atMs: deps.clock(),
  });
  await audit(ctx, deps, 'SESSION_CANCELLED', {
    sessionId,
    dentallyPatientId: after.patient.dentallyPatientId,
    dentallyAppointmentId: after.patient.appointment.appointmentId,
    details: { statusBefore: before.status },
  });
  return { session: after };
}

/** The open session for this surgery or clinician, so a refreshed page restores it with its locked patient. */
export async function getActiveSession(
  ctx: StaffContext,
  deps: HandlerDeps,
  input: { surgeryId?: unknown; practitionerId?: unknown },
): Promise<{ session: ScribeSession | null }> {
  await requireRole(ctx, deps, CLINICAL_ROLES, 'getActiveSession');
  const surgeryId = optId(input.surgeryId, 'surgery');
  const practitionerId = optId(input.practitionerId, 'clinician');
  if (!surgeryId && !practitionerId) throw new AppError('VALIDATION', 'Give a surgery or a clinician.');
  // This surgery's open session first, then any open session for the clinician (they may have moved surgery).
  const inSurgery = surgeryId ? await deps.sessions.findActive(ctx.clinicId, { surgeryId }) : [];
  const forClinician = practitionerId ? await deps.sessions.findActive(ctx.clinicId, { clinicianId: practitionerId }) : [];
  return { session: [...inSurgery, ...forClinician].find((s) => !isTerminal(s.status)) ?? null };
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
