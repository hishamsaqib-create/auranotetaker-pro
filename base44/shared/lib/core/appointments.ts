// GENERATED from lib/core/appointments.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Normalised diary types shared by the prediction engine, the server handlers and the UI.
// These carry only what the scribe needs: identifiers, times, state, reason and a display name.

export const KNOWN_APPOINTMENT_STATES = [
  'Pending',
  'Confirmed',
  'Arrived',
  'In surgery',
  'Completed',
  'Cancelled',
  'Did not attend',
] as const;

export type KnownAppointmentState = (typeof KNOWN_APPOINTMENT_STATES)[number];

/** `Unknown` means Dentally returned a state this version does not recognise. It is never treated as safe. */
export type AppointmentState = KnownAppointmentState | 'Unknown';

export interface DiaryAppointment {
  appointmentId: string;
  /** Null for diary entries with no patient (blocked time, meetings). Never suggested. */
  patientId: string | null;
  /** Display only. Never persisted by AuraNoteTaker. */
  patientName: string | null;
  practitionerId: string;
  roomId: string | null;
  startMs: number;
  finishMs: number;
  state: AppointmentState;
  /** The raw Dentally state string, kept when `state` is `Unknown` so the UI can show it. */
  rawState: string | null;
  reason: string | null;
  inSurgeryAtMs: number | null;
  arrivedAtMs: number | null;
  completedAtMs: number | null;
}

/** Wire format for the diary returned by the backend (ISO strings instead of epoch numbers). */
export interface DiaryAppointmentDto {
  appointmentId: string;
  patientId: string | null;
  patientName: string | null;
  practitionerId: string;
  roomId: string | null;
  startTime: string;
  finishTime: string;
  state: AppointmentState;
  rawState: string | null;
  reason: string | null;
  inSurgeryAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
}

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const fromIso = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export function toDiaryDto(a: DiaryAppointment): DiaryAppointmentDto {
  return {
    appointmentId: a.appointmentId,
    patientId: a.patientId,
    patientName: a.patientName,
    practitionerId: a.practitionerId,
    roomId: a.roomId,
    startTime: new Date(a.startMs).toISOString(),
    finishTime: new Date(a.finishMs).toISOString(),
    state: a.state,
    rawState: a.rawState,
    reason: a.reason,
    inSurgeryAt: toIso(a.inSurgeryAtMs),
    arrivedAt: toIso(a.arrivedAtMs),
    completedAt: toIso(a.completedAtMs),
  };
}

/** Returns null if the DTO's times are unreadable; callers drop such entries rather than guess. */
export function fromDiaryDto(d: DiaryAppointmentDto): DiaryAppointment | null {
  const startMs = fromIso(d.startTime);
  const finishMs = fromIso(d.finishTime);
  if (startMs === null || finishMs === null) return null;
  return {
    appointmentId: d.appointmentId,
    patientId: d.patientId,
    patientName: d.patientName,
    practitionerId: d.practitionerId,
    roomId: d.roomId,
    startMs,
    finishMs,
    state: d.state,
    rawState: d.rawState,
    reason: d.reason,
    inSurgeryAtMs: fromIso(d.inSurgeryAt),
    arrivedAtMs: fromIso(d.arrivedAt),
    completedAtMs: fromIso(d.completedAt),
  };
}

/** States in which an appointment can never be the patient currently in the chair. */
export function isClosedState(state: AppointmentState): boolean {
  return state === 'Cancelled' || state === 'Did not attend' || state === 'Completed';
}
