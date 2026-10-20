// GENERATED from lib/core/session.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Scribe session state machine and patient lock.
//
// SAFETY invariants (tested in session.test.ts, hazards H02, H03 and H12):
// - The patient is fixed when the session is created. Only REASSIGN_PATIENT changes it,
//   and that needs a reason, is refused while recording and after approval, and resets
//   permission when no recording has happened yet.
// - Recording cannot start until the patient's permission is recorded as given.
// - A decline (or withdrawal) is terminal: no recording, no AI processing.
// - Terminal sessions accept no events.
// Transitions are pure: they return a new session object and never mutate the input.

import type { AppointmentState } from './appointments.ts';
import { MINUTE_MS } from './time.ts';

export type SessionStatus =
  | 'PATIENT_CONFIRMED'
  | 'CONSENT_DECLINED'
  | 'READY'
  | 'RECORDING'
  | 'PAUSED'
  | 'STOPPED'
  | 'GENERATING'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'DISCARDED'
  | 'CANCELLED';

const TERMINAL: ReadonlySet<SessionStatus> = new Set(['CONSENT_DECLINED', 'APPROVED', 'DISCARDED', 'CANCELLED']);

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

/** Whether a session in this status can still be cancelled (only before anything has been recorded). */
export function canCancel(status: SessionStatus): boolean {
  return status === 'PATIENT_CONFIRMED' || status === 'READY';
}

/**
 * How the patient was confirmed, kept so near misses can be measured:
 * accepted the single suggestion; picked a different appointment than suggested; picked one of
 * several equally likely appointments (ambiguous diary); or picked from the diary with no suggestion.
 */
export type ConfirmationMethod = 'CONFIRMED_SUGGESTION' | 'CHOSE_ALTERNATIVE' | 'RESOLVED_AMBIGUITY' | 'CHOSE_FROM_DIARY';

export interface AppointmentSnapshot {
  appointmentId: string;
  practitionerId: string;
  roomId: string | null;
  startMs: number;
  finishMs: number;
  reason: string | null;
  stateAtConfirmation: AppointmentState;
}

export interface SessionPatient {
  dentallyPatientId: string;
  appointment: AppointmentSnapshot;
}

export interface Reassignment {
  fromPatientId: string;
  toPatientId: string;
  fromAppointmentId: string;
  toAppointmentId: string;
  by: string;
  atMs: number;
  /** Staff-entered reason. Stored on the session (protected clinical entity), never in audit metadata. */
  reason: string;
  /** True when a recording already existed and permission was re-confirmed for the corrected patient. */
  consentCarriedOver: boolean;
}

export type ConsentStatus = 'PENDING' | 'GIVEN' | 'DECLINED';

export interface ScribeSession {
  sessionId: string;
  clinicId: string;
  /** Dentally practitioner ID of the treating clinician. */
  clinicianId: string;
  surgeryId: string | null;
  status: SessionStatus;
  patient: SessionPatient;
  confirmation: {
    method: ConfirmationMethod;
    predictedAppointmentId: string | null;
    matchedPrediction: boolean;
    confirmedBy: string;
    confirmedAtMs: number;
  };
  consent: { status: ConsentStatus; recordedBy: string | null; recordedAtMs: number | null };
  reassignments: Reassignment[];
  statusHistory: { status: SessionStatus; atMs: number; by: string }[];
  recordingStartedAtMs: number | null;
  recordingStoppedAtMs: number | null;
  clientDeviceId: string | null;
  /** Optimistic concurrency token. Incremented on every successful transition. */
  version: number;
}

export interface CreateSessionParams {
  sessionId: string;
  clinicId: string;
  clinicianId: string;
  surgeryId: string | null;
  patient: SessionPatient;
  method: ConfirmationMethod;
  predictedAppointmentId: string | null;
  confirmedBy: string;
  atMs: number;
  clientDeviceId?: string | null;
}

export function createSession(p: CreateSessionParams): ScribeSession {
  return {
    sessionId: p.sessionId,
    clinicId: p.clinicId,
    clinicianId: p.clinicianId,
    surgeryId: p.surgeryId,
    status: 'PATIENT_CONFIRMED',
    patient: structuredClone(p.patient),
    confirmation: {
      method: p.method,
      predictedAppointmentId: p.predictedAppointmentId,
      matchedPrediction: p.predictedAppointmentId !== null && p.predictedAppointmentId === p.patient.appointment.appointmentId,
      confirmedBy: p.confirmedBy,
      confirmedAtMs: p.atMs,
    },
    consent: { status: 'PENDING', recordedBy: null, recordedAtMs: null },
    reassignments: [],
    statusHistory: [{ status: 'PATIENT_CONFIRMED', atMs: p.atMs, by: p.confirmedBy }],
    recordingStartedAtMs: null,
    recordingStoppedAtMs: null,
    clientDeviceId: p.clientDeviceId ?? null,
    version: 1,
  };
}

interface Actor {
  by: string;
  atMs: number;
}

export type SessionEvent =
  | ({ type: 'RECORD_CONSENT'; given: boolean } & Actor)
  | ({ type: 'START_RECORDING' } & Actor)
  | ({ type: 'PAUSE' } & Actor)
  | ({ type: 'RESUME' } & Actor)
  | ({ type: 'STOP' } & Actor)
  | ({ type: 'BEGIN_GENERATION' } & Actor)
  | ({ type: 'GENERATION_SUCCEEDED' } & Actor)
  | ({ type: 'GENERATION_FAILED' } & Actor)
  | ({ type: 'REGENERATE' } & Actor)
  | ({ type: 'APPROVE' } & Actor)
  | ({ type: 'DISCARD'; reason: string } & Actor)
  | ({ type: 'CANCEL' } & Actor)
  /** System-only: closes a session left open from an earlier day with nothing recorded. */
  | ({ type: 'EXPIRE' } & Actor)
  | ({
      type: 'REASSIGN_PATIENT';
      to: SessionPatient;
      reason: string;
      /** Required once anything has been recorded: the user confirms the person who gave permission is the corrected patient. */
      consentConfirmedForNewPatient?: boolean;
    } & Actor);

export type SessionErrorCode =
  | 'TERMINAL'
  | 'INVALID_TRANSITION'
  | 'CONSENT_REQUIRED'
  | 'REASON_REQUIRED'
  | 'REASSIGN_WHILE_RECORDING'
  | 'REASSIGN_AFTER_APPROVAL'
  | 'SAME_PATIENT';

export type TransitionResult =
  | { ok: true; session: ScribeSession }
  | { ok: false; code: SessionErrorCode; message: string };

const fail = (code: SessionErrorCode, message: string): TransitionResult => ({ ok: false, code, message });

const MIN_REASON_LENGTH = 3;
const hasReason = (r: string | undefined) => typeof r === 'string' && r.trim().length >= MIN_REASON_LENGTH;

/** Statuses from which the patient can withdraw permission (the handler must then delete any captured data). */
const WITHDRAWABLE: ReadonlySet<SessionStatus> = new Set([
  'PATIENT_CONFIRMED',
  'READY',
  'RECORDING',
  'PAUSED',
  'STOPPED',
  'GENERATING',
  'IN_REVIEW',
]);

/** Simple transitions that need no extra checks: [from, event] -> to. */
const SIMPLE: Record<string, SessionStatus> = {
  'READY:START_RECORDING': 'RECORDING',
  'RECORDING:PAUSE': 'PAUSED',
  'PAUSED:RESUME': 'RECORDING',
  'STOPPED:RESUME': 'RECORDING',
  'RECORDING:STOP': 'STOPPED',
  'PAUSED:STOP': 'STOPPED',
  'STOPPED:BEGIN_GENERATION': 'GENERATING',
  'GENERATING:GENERATION_SUCCEEDED': 'IN_REVIEW',
  'GENERATING:GENERATION_FAILED': 'STOPPED',
  'IN_REVIEW:REGENERATE': 'GENERATING',
  'IN_REVIEW:APPROVE': 'APPROVED',
  'PATIENT_CONFIRMED:CANCEL': 'CANCELLED',
  'READY:CANCEL': 'CANCELLED',
  'PATIENT_CONFIRMED:EXPIRE': 'CANCELLED',
  'READY:EXPIRE': 'CANCELLED',
};

function advance(s: ScribeSession, to: SessionStatus, e: Actor, patch: Partial<ScribeSession> = {}): ScribeSession {
  const next: ScribeSession = {
    ...structuredClone(s),
    ...patch,
    status: to,
    version: s.version + 1,
  };
  if (to !== s.status) next.statusHistory = [...next.statusHistory, { status: to, atMs: e.atMs, by: e.by }];
  return next;
}

export function transition(s: ScribeSession, e: SessionEvent): TransitionResult {
  if (isTerminal(s.status)) {
    if (e.type === 'REASSIGN_PATIENT' && s.status === 'APPROVED') {
      return fail('REASSIGN_AFTER_APPROVAL', 'An approved note cannot be moved to another patient. Use an addendum.');
    }
    return fail('TERMINAL', `Session is ${s.status} and accepts no further changes.`);
  }

  switch (e.type) {
    case 'RECORD_CONSENT': {
      if (!e.given) {
        if (!WITHDRAWABLE.has(s.status)) return fail('INVALID_TRANSITION', `Cannot record a decline while ${s.status}.`);
        return {
          ok: true,
          session: advance(s, 'CONSENT_DECLINED', e, { consent: { status: 'DECLINED', recordedBy: e.by, recordedAtMs: e.atMs } }),
        };
      }
      if (s.status !== 'PATIENT_CONFIRMED') return fail('INVALID_TRANSITION', `Permission is already recorded (${s.status}).`);
      return {
        ok: true,
        session: advance(s, 'READY', e, { consent: { status: 'GIVEN', recordedBy: e.by, recordedAtMs: e.atMs } }),
      };
    }

    case 'START_RECORDING': {
      if (s.consent.status !== 'GIVEN') return fail('CONSENT_REQUIRED', 'Record the patient\'s permission before recording.');
      if (s.status !== 'READY') return fail('INVALID_TRANSITION', `Cannot start recording while ${s.status}.`);
      return { ok: true, session: advance(s, 'RECORDING', e, { recordingStartedAtMs: s.recordingStartedAtMs ?? e.atMs }) };
    }

    case 'DISCARD': {
      if (!hasReason(e.reason)) return fail('REASON_REQUIRED', 'Give a reason for discarding the draft.');
      if (s.status !== 'STOPPED' && s.status !== 'IN_REVIEW') {
        return fail('INVALID_TRANSITION', `Cannot discard while ${s.status}.`);
      }
      return { ok: true, session: advance(s, 'DISCARDED', e) };
    }

    case 'REASSIGN_PATIENT': {
      if (!hasReason(e.reason)) return fail('REASON_REQUIRED', 'Give a reason for changing the patient.');
      if (s.status === 'RECORDING' || s.status === 'GENERATING') {
        return fail('REASSIGN_WHILE_RECORDING', 'Pause the session before changing the patient.');
      }
      if (e.to.dentallyPatientId === s.patient.dentallyPatientId) {
        return fail('SAME_PATIENT', 'That is already the patient for this session.');
      }
      const recorded = s.recordingStartedAtMs !== null;
      if (recorded && e.consentConfirmedForNewPatient !== true) {
        return fail('CONSENT_REQUIRED', 'Confirm that the person who gave permission is the corrected patient.');
      }
      const reassignment: Reassignment = {
        fromPatientId: s.patient.dentallyPatientId,
        toPatientId: e.to.dentallyPatientId,
        fromAppointmentId: s.patient.appointment.appointmentId,
        toAppointmentId: e.to.appointment.appointmentId,
        by: e.by,
        atMs: e.atMs,
        reason: e.reason.trim(),
        consentCarriedOver: recorded,
      };
      const patch: Partial<ScribeSession> = {
        patient: structuredClone(e.to),
        reassignments: [...s.reassignments, reassignment],
      };
      if (!recorded) {
        // Nothing captured yet: permission was obtained for the wrong patient label, so ask again.
        patch.consent = { status: 'PENDING', recordedBy: null, recordedAtMs: null };
        return { ok: true, session: advance(s, 'PATIENT_CONFIRMED', e, patch) };
      }
      // A draft may contain the previous patient's Dentally context, so it is superseded:
      // the session goes back to STOPPED and must be regenerated for the corrected patient.
      const to: SessionStatus = s.status === 'IN_REVIEW' ? 'STOPPED' : s.status;
      return { ok: true, session: advance(s, to, e, patch) };
    }

    case 'STOP': {
      const to = SIMPLE[`${s.status}:STOP`];
      if (!to) return fail('INVALID_TRANSITION', `Cannot stop while ${s.status}.`);
      return { ok: true, session: advance(s, to, e, { recordingStoppedAtMs: e.atMs }) };
    }

    default: {
      const to = SIMPLE[`${s.status}:${e.type}`];
      if (!to) return fail('INVALID_TRANSITION', `Cannot ${e.type} while ${s.status}.`);
      return { ok: true, session: advance(s, to, e) };
    }
  }
}

// ---------------------------------------------------------------------------
// Forgotten-stop detection (hazard H03). Pure; the UI shows the warning, it never switches patient.

export type OverrunWarning =
  | { code: 'NEXT_APPOINTMENT_STARTED'; nextAppointmentId: string; minutesSinceNextStart: number }
  | { code: 'PAST_APPOINTMENT_END'; minutesPastEnd: number };

export function detectSessionOverrun(
  s: Pick<ScribeSession, 'status' | 'patient'>,
  nowMs: number,
  nextAppointment: { appointmentId: string; startMs: number; patientId: string | null } | null,
  graceMinutes = 10,
): OverrunWarning | null {
  if (s.status !== 'RECORDING' && s.status !== 'PAUSED') return null;
  if (
    nextAppointment &&
    nextAppointment.appointmentId !== s.patient.appointment.appointmentId &&
    nextAppointment.patientId !== s.patient.dentallyPatientId &&
    nextAppointment.startMs <= nowMs
  ) {
    return {
      code: 'NEXT_APPOINTMENT_STARTED',
      nextAppointmentId: nextAppointment.appointmentId,
      minutesSinceNextStart: Math.floor((nowMs - nextAppointment.startMs) / MINUTE_MS),
    };
  }
  const minutesPastEnd = Math.floor((nowMs - s.patient.appointment.finishMs) / MINUTE_MS);
  if (minutesPastEnd > graceMinutes) return { code: 'PAST_APPOINTMENT_END', minutesPastEnd };
  return null;
}
