// Likely-current-patient engine.
//
// SAFETY: this module only ever *suggests*. It never selects a patient, never creates
// a session and has no side effects. When the diary does not point clearly at one
// patient it returns AMBIGUOUS (the user must choose, with no default) or NONE.
// See docs/clinical-safety.md (hazard H01) and docs/architecture.md section 5.2.

import type { DiaryAppointment } from './appointments.ts';
import { isClosedState } from './appointments.ts';
import { MINUTE_MS, formatClock, formatTimeRange } from './time.ts';

export interface PredictionOptions {
  /** An appointment starting within this many minutes counts as a (weaker) candidate. */
  earlyStartMinutes: number;
  /** An appointment whose scheduled finish passed within this many minutes, and is not completed, counts as overrunning. */
  overrunMinutes: number;
  /** "In surgery" more than this many minutes after the scheduled finish is treated as out of date. */
  staleInSurgeryMinutes: number;
  /** "In surgery" is only believed from this many minutes before the scheduled start (patients taken in early). */
  earlyInSurgeryMinutes: number;
}

// Starting values. Tune per clinic (Clinic.settings) once real diary behaviour is known (issue P1-07).
// A practice that leaves appointments "In surgery" long after they finish would otherwise see
// constant ambiguity, which trains people to click through warnings; hence the 30-minute staleness cut-off.
export const DEFAULT_PREDICTION_OPTIONS: Readonly<PredictionOptions> = Object.freeze({
  earlyStartMinutes: 10,
  overrunMinutes: 30,
  staleInSurgeryMinutes: 30,
  earlyInSurgeryMinutes: 60,
});

export interface PredictionInput {
  nowMs: number;
  /** Dentally practitioner ID of the clinician selected on this PC. */
  practitionerId: string;
  /** Dentally room ID of the surgery selected on this PC, when known. */
  roomId?: string | null;
  appointments: readonly DiaryAppointment[];
  /** Appointments already finished with in AuraNoteTaker today (approved, or patient declined). Never suggested again. */
  excludeAppointmentIds?: readonly string[];
  options?: Partial<PredictionOptions>;
}

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type SignalCode =
  | 'IN_SURGERY_STATE'
  | 'WITHIN_SCHEDULED_TIME'
  | 'STARTS_SOON'
  | 'OVERRUNNING'
  | 'ARRIVED'
  | 'ROOM_MATCH'
  | 'ROOM_MISMATCH'
  | 'STALE_IN_SURGERY'
  | 'UNKNOWN_STATE';

export interface Signal {
  code: SignalCode;
  /** Minutes until start (STARTS_SOON) or past the scheduled finish (OVERRUNNING, STALE_IN_SURGERY). */
  minutes?: number;
}

export interface Candidate {
  appointment: DiaryAppointment;
  /** 1 is strongest: in surgery or inside the scheduled time. 2: starting soon or overrunning. 3: weak (stale state). */
  tier: 1 | 2 | 3;
  confidence: Confidence;
  signals: Signal[];
}

export type PredictionWarningCode =
  | 'DOUBLE_BOOKED'
  | 'PREVIOUS_STILL_IN_SURGERY'
  | 'MULTIPLE_CANDIDATES'
  | 'ROOM_MISMATCH'
  | 'UNKNOWN_STATE'
  | 'STALE_IN_SURGERY'
  | 'INVALID_APPOINTMENT_TIMES'
  | 'DUPLICATE_APPOINTMENT';

export interface PredictionWarning {
  code: PredictionWarningCode;
  appointmentIds: string[];
}

export type PredictionStatus = 'LIKELY' | 'AMBIGUOUS' | 'NONE';

export interface PredictionResult {
  status: PredictionStatus;
  /** Set only when status is LIKELY. */
  likely: Candidate | null;
  /** All candidates, best first. For AMBIGUOUS the competing top-tier candidates come first. */
  candidates: Candidate[];
  warnings: PredictionWarning[];
  /** The clinician's next appointment that starts after now (for NONE and after a session ends). */
  nextAppointment: DiaryAppointment | null;
  evaluatedAtMs: number;
}

const has = (c: Candidate, code: SignalCode) => c.signals.some((s) => s.code === code);

function addWarning(warnings: PredictionWarning[], code: PredictionWarningCode, ids: string[]) {
  const existing = warnings.find((w) => w.code === code);
  if (existing) {
    for (const id of ids) if (!existing.appointmentIds.includes(id)) existing.appointmentIds.push(id);
  } else {
    warnings.push({ code, appointmentIds: [...ids] });
  }
}

function baseConfidence(tier: 1 | 2 | 3): Confidence {
  return tier === 1 ? 'HIGH' : tier === 2 ? 'MEDIUM' : 'LOW';
}

function downgrade(c: Confidence): Confidence {
  return c === 'HIGH' ? 'MEDIUM' : 'LOW';
}

/** Distance in ms between now and the appointment (0 when now is inside it). Used for ordering only. */
function distanceFromNow(a: DiaryAppointment, now: number): number {
  if (now < a.startMs) return a.startMs - now;
  if (now >= a.finishMs) return now - a.finishMs;
  return 0;
}

export function predictLikelyPatient(input: PredictionInput): PredictionResult {
  const opts: PredictionOptions = { ...DEFAULT_PREDICTION_OPTIONS, ...input.options };
  const now = input.nowMs;
  const excluded = new Set(input.excludeAppointmentIds ?? []);
  const warnings: PredictionWarning[] = [];

  // 1. De-duplicate, keep the clinician's own appointments, drop unreadable times.
  const seen = new Set<string>();
  const own: DiaryAppointment[] = [];
  for (const a of input.appointments) {
    if (seen.has(a.appointmentId)) {
      addWarning(warnings, 'DUPLICATE_APPOINTMENT', [a.appointmentId]);
      continue;
    }
    seen.add(a.appointmentId);
    if (a.practitionerId !== input.practitionerId) continue;
    if (!Number.isFinite(a.startMs) || !Number.isFinite(a.finishMs) || a.finishMs <= a.startMs) {
      addWarning(warnings, 'INVALID_APPOINTMENT_TIMES', [a.appointmentId]);
      continue;
    }
    own.push(a);
  }

  // 2. Only real, open appointments with a patient can be suggested.
  const eligible = own.filter((a) => a.patientId !== null && !isClosedState(a.state) && !excluded.has(a.appointmentId));

  // 3. Classify each eligible appointment.
  const candidates: Candidate[] = [];
  for (const a of eligible) {
    const signals: Signal[] = [];
    const minutesToStart = (a.startMs - now) / MINUTE_MS;
    const minutesPastFinish = (now - a.finishMs) / MINUTE_MS;

    const inSurgery = a.state === 'In surgery';
    const staleInSurgery = inSurgery && minutesPastFinish > opts.staleInSurgeryMinutes;
    const plausibleInSurgery = inSurgery && !staleInSurgery && minutesToStart <= opts.earlyInSurgeryMinutes;
    const within = a.startMs <= now && now < a.finishMs;
    const startsSoon = now < a.startMs && minutesToStart <= opts.earlyStartMinutes;
    const overrunning = now >= a.finishMs && minutesPastFinish <= opts.overrunMinutes;

    let tier: 1 | 2 | 3 | null = null;
    if (plausibleInSurgery) {
      tier = 1;
      signals.push({ code: 'IN_SURGERY_STATE' });
      if (now >= a.finishMs) signals.push({ code: 'OVERRUNNING', minutes: Math.floor(minutesPastFinish) });
    }
    if (within) {
      tier = 1;
      signals.push({ code: 'WITHIN_SCHEDULED_TIME' });
    }
    if (tier === null && startsSoon) {
      tier = 2;
      signals.push({ code: 'STARTS_SOON', minutes: Math.ceil(minutesToStart) });
    }
    if (tier === null && overrunning) {
      tier = 2;
      signals.push({ code: 'OVERRUNNING', minutes: Math.floor(minutesPastFinish) });
    }
    if (tier === null && staleInSurgery) {
      tier = 3;
      signals.push({ code: 'STALE_IN_SURGERY', minutes: Math.floor(minutesPastFinish) });
      addWarning(warnings, 'STALE_IN_SURGERY', [a.appointmentId]);
    }
    if (tier === null) continue;

    let confidence = baseConfidence(tier);
    if (a.state === 'Arrived') signals.push({ code: 'ARRIVED' });
    if (a.state === 'Unknown') {
      signals.push({ code: 'UNKNOWN_STATE' });
      addWarning(warnings, 'UNKNOWN_STATE', [a.appointmentId]);
      confidence = downgrade(confidence);
    }
    if (input.roomId && a.roomId) {
      if (input.roomId === a.roomId) {
        signals.push({ code: 'ROOM_MATCH' });
      } else {
        signals.push({ code: 'ROOM_MISMATCH' });
        addWarning(warnings, 'ROOM_MISMATCH', [a.appointmentId]);
        if (confidence !== 'LOW') confidence = downgrade(confidence);
      }
    }
    candidates.push({ appointment: a, tier, confidence, signals });
  }

  // 4. Rank: tier, then in-surgery first, then closeness to now, then start time, then ID (deterministic).
  candidates.sort((x, y) => {
    if (x.tier !== y.tier) return x.tier - y.tier;
    const xs = has(x, 'IN_SURGERY_STATE') ? 0 : 1;
    const ys = has(y, 'IN_SURGERY_STATE') ? 0 : 1;
    if (xs !== ys) return xs - ys;
    const dx = distanceFromNow(x.appointment, now);
    const dy = distanceFromNow(y.appointment, now);
    if (dx !== dy) return dx - dy;
    if (x.appointment.startMs !== y.appointment.startMs) return x.appointment.startMs - y.appointment.startMs;
    return x.appointment.appointmentId < y.appointment.appointmentId ? -1 : 1;
  });

  const nextAppointment =
    eligible
      .filter((a) => a.startMs > now)
      .sort((x, y) => x.startMs - y.startMs || (x.appointmentId < y.appointmentId ? -1 : 1))[0] ?? null;

  const result = (status: PredictionStatus, likely: Candidate | null): PredictionResult => ({
    status,
    likely,
    candidates,
    warnings,
    nextAppointment,
    evaluatedAtMs: now,
  });

  const first = candidates[0];
  if (!first) return result('NONE', null);
  // Only weak (stale) candidates: nothing is current. They stay in the list for an explicit choice.
  if (first.tier === 3) return result('NONE', null);

  const top = candidates.filter((c) => c.tier === first.tier);
  if (top.length > 1) {
    const ids = top.map((c) => c.appointment.appointmentId);
    const withinCount = top.filter((c) => has(c, 'WITHIN_SCHEDULED_TIME')).length;
    const previousStillIn = top.some((c) => has(c, 'IN_SURGERY_STATE') && has(c, 'OVERRUNNING'));
    if (previousStillIn && top.some((c) => has(c, 'WITHIN_SCHEDULED_TIME') && !has(c, 'IN_SURGERY_STATE'))) {
      addWarning(warnings, 'PREVIOUS_STILL_IN_SURGERY', ids);
    } else if (withinCount > 1) {
      addWarning(warnings, 'DOUBLE_BOOKED', ids);
    } else {
      addWarning(warnings, 'MULTIPLE_CANDIDATES', ids);
    }
    return result('AMBIGUOUS', null);
  }

  // A single top candidate. Only HIGH or MEDIUM confidence is offered as "likely"; LOW needs an explicit choice.
  if (first.confidence === 'LOW') return result('NONE', null);
  return result('LIKELY', first);
}

// ---------------------------------------------------------------------------
// Explanations for the UI. Kept here so the wording is tested with the logic.

export interface ExplainContext {
  timeZone: string;
  clinicianName?: string | null;
  /** Dentally room ID to surgery name. */
  roomNames?: Readonly<Record<string, string>>;
  selectedRoomId?: string | null;
}

function roomName(ctx: ExplainContext, roomId: string | null | undefined): string | null {
  if (!roomId) return null;
  return ctx.roomNames?.[roomId] ?? null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human-readable reasons, most important first. The first line always states the booking. */
export function explainCandidate(c: Candidate, ctx: ExplainContext): string[] {
  const a = c.appointment;
  const lines: string[] = [];
  const who = ctx.clinicianName ? ` with ${ctx.clinicianName}` : '';
  lines.push(`Appointment scheduled ${formatTimeRange(a.startMs, a.finishMs, ctx.timeZone)}${who}`);
  for (const s of c.signals) {
    switch (s.code) {
      case 'IN_SURGERY_STATE':
        lines.push('Dentally shows this patient as In surgery');
        break;
      case 'WITHIN_SCHEDULED_TIME':
        lines.push('The current time falls inside this appointment');
        break;
      case 'STARTS_SOON':
        lines.push(`Starts in ${plural(s.minutes ?? 0, 'minute')}`);
        break;
      case 'OVERRUNNING':
        lines.push(
          `Was due to finish at ${formatClock(a.finishMs, ctx.timeZone)} (${plural(s.minutes ?? 0, 'minute')} ago) and is not marked completed`,
        );
        break;
      case 'ARRIVED':
        lines.push('Patient is marked Arrived');
        break;
      case 'ROOM_MATCH': {
        const name = roomName(ctx, a.roomId);
        lines.push(name ? `Booked in ${name}, the surgery selected on this computer` : 'Booked in the surgery selected on this computer');
        break;
      }
      case 'ROOM_MISMATCH': {
        const booked = roomName(ctx, a.roomId) ?? 'another surgery';
        const selected = roomName(ctx, ctx.selectedRoomId);
        lines.push(selected ? `Booked in ${booked}, not ${selected}` : `Booked in ${booked}, not the surgery selected on this computer`);
        break;
      }
      case 'STALE_IN_SURGERY':
        lines.push(`Still marked In surgery ${plural(s.minutes ?? 0, 'minute')} after its scheduled finish, so the status may be out of date`);
        break;
      case 'UNKNOWN_STATE':
        lines.push(`Dentally returned an unrecognised status${a.rawState ? ` ("${a.rawState}")` : ''}. Check before confirming`);
        break;
    }
  }
  return lines;
}

export function explainWarning(w: PredictionWarning): string {
  switch (w.code) {
    case 'DOUBLE_BOOKED':
      return 'Two appointments for this clinician overlap now. Check who is in the chair.';
    case 'PREVIOUS_STILL_IN_SURGERY':
      return 'The previous patient is still marked In surgery and the next appointment has started. Check who is in the chair.';
    case 'MULTIPLE_CANDIDATES':
      return 'More than one appointment could be the current one. Check who is in the chair.';
    case 'ROOM_MISMATCH':
      return 'This appointment is booked in a different surgery from the one selected on this computer.';
    case 'UNKNOWN_STATE':
      return 'Dentally returned an appointment status this version does not recognise.';
    case 'STALE_IN_SURGERY':
      return 'An earlier appointment is still marked In surgery long after it was due to finish.';
    case 'INVALID_APPOINTMENT_TIMES':
      return 'An appointment with unreadable times was ignored.';
    case 'DUPLICATE_APPOINTMENT':
      return 'A duplicated diary entry was ignored.';
  }
}
