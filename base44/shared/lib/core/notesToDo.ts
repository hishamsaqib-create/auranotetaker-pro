// GENERATED from lib/core/notesToDo.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Which appointments still need a clinical note. Pure.
//
// Dentally does not let other apps read clinical notes, so AuraNoteTaker cannot see notes written straight into
// Dentally. A note counts as done when it was copied from AuraNoteTaker for that appointment's session, or when a
// clinician ticked it off as written in Dentally. Everything else that has finished is listed.
//
// SAFETY: nothing is guessed. An appointment whose time has passed but which Dentally does not show as completed is
// listed separately ("check"), not hidden and not counted as needing no note. An unknown state is listed too.

import type { DiaryAppointment } from './appointments.ts';

/** How far back the list goes. Older days are for the clinical-record audit (Phase 6). */
export const NOTES_TODO_MAX_DAYS = 14;

export type NoteMarkStatus = 'COPIED' | 'WRITTEN_IN_DENTALLY';

export interface NoteMark {
  appointmentId: string;
  practitionerId: string;
  /** Clinic-local calendar date of the appointment, YYYY-MM-DD. */
  date: string;
  status: NoteMarkStatus;
  byEmail: string;
  atMs: number;
  sessionId: string | null;
}

/**
 * DUE: the appointment happened (completed, or in surgery and past its finish time), so it needs a note.
 * CHECK: its time has passed but Dentally does not show it as completed (or shows a state we do not know).
 * Null: no note is expected yet or at all (still to come, in progress, cancelled, did not attend, no patient).
 */
export type NoteDue = 'DUE' | 'CHECK' | null;

export function noteDue(a: DiaryAppointment, nowMs: number): NoteDue {
  if (!a.patientId) return null;
  switch (a.state) {
    case 'Cancelled':
    case 'Did not attend':
      return null;
    case 'Completed':
      return 'DUE';
    case 'In surgery':
      return a.finishMs <= nowMs ? 'DUE' : null;
    case 'Pending':
    case 'Confirmed':
    case 'Arrived':
    case 'Unknown':
      return a.finishMs <= nowMs ? 'CHECK' : null;
    default:
      return 'CHECK';
  }
}

/** The calendar dates the list may show: today and the days before it, newest first. */
export function notesToDoDates(today: string, days = NOTES_TODO_MAX_DAYS): string[] {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const t = new Date(Date.UTC(y, m - 1, d - i));
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}
