import { describe, expect, it } from 'vitest';
import type { DiaryAppointment } from './appointments.ts';
import { noteDue, notesToDoDates } from './notesToDo.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const appt = (over: Partial<DiaryAppointment>): DiaryAppointment => ({
  appointmentId: 'A1',
  patientId: 'P1',
  patientName: 'Test Patient',
  practitionerId: 'PR1',
  roomId: null,
  startMs: NOW - 60 * 60_000,
  finishMs: NOW - 30 * 60_000,
  state: 'Completed',
  rawState: 'Completed',
  reason: null,
  inSurgeryAtMs: null,
  arrivedAtMs: null,
  completedAtMs: null,
  ...over,
});

describe('noteDue', () => {
  it('needs a note once an appointment is completed, or in surgery past its finish', () => {
    expect(noteDue(appt({}), NOW)).toBe('DUE');
    expect(noteDue(appt({ state: 'In surgery' }), NOW)).toBe('DUE');
    expect(noteDue(appt({ state: 'In surgery', finishMs: NOW + 1 }), NOW)).toBeNull();
  });

  it('asks for a check when the time has passed but Dentally does not show it completed, including unknown states', () => {
    for (const state of ['Pending', 'Confirmed', 'Arrived', 'Unknown'] as const) expect(noteDue(appt({ state }), NOW)).toBe('CHECK');
    expect(noteDue(appt({ state: 'Arrived', finishMs: NOW + 1 }), NOW)).toBeNull();
  });

  it('expects no note for cancelled, did not attend, or diary entries with no patient', () => {
    expect(noteDue(appt({ state: 'Cancelled' }), NOW)).toBeNull();
    expect(noteDue(appt({ state: 'Did not attend' }), NOW)).toBeNull();
    expect(noteDue(appt({ patientId: null }), NOW)).toBeNull();
  });
});

describe('notesToDoDates', () => {
  it('counts back across month ends', () => {
    expect(notesToDoDates('2026-03-02', 4)).toEqual(['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27']);
  });
});
