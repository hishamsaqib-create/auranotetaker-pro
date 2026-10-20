import { describe, expect, it } from 'vitest';
import type { DiaryAppointment } from './appointments.ts';
import { explainCandidate, explainWarning, predictLikelyPatient } from './prediction.ts';

// 20 October 2026 is British Summer Time (UTC+1).
const DAY = '2026-10-20';
const at = (hhmm: string, day = DAY, offset = '+01:00') => Date.parse(`${day}T${hhmm}:00${offset}`);

const DR = 'pr-1';
const OTHER_DR = 'pr-2';

let seq = 0;
function appt(start: string, finish: string, overrides: Partial<DiaryAppointment> = {}): DiaryAppointment {
  seq += 1;
  return {
    appointmentId: `a-${seq}`,
    patientId: `p-${seq}`,
    patientName: `Patient ${seq}`,
    practitionerId: DR,
    roomId: 'room-2',
    startMs: at(start),
    finishMs: at(finish),
    state: 'Confirmed',
    rawState: null,
    reason: 'Exam',
    inSurgeryAtMs: null,
    arrivedAtMs: null,
    completedAtMs: null,
    ...overrides,
  };
}

const ctx = { timeZone: 'Europe/London', clinicianName: 'Dr Test', roomNames: { 'room-2': 'Surgery 2', 'room-3': 'Surgery 3' }, selectedRoomId: 'room-2' };

describe('predictLikelyPatient', () => {
  it('suggests the appointment the current time falls inside, with HIGH confidence and a booking explanation', () => {
    const current = appt('10:30', '11:15');
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, roomId: 'room-2', appointments: [current] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.appointment.appointmentId).toBe(current.appointmentId);
    expect(r.likely?.confidence).toBe('HIGH');
    const reasons = explainCandidate(r.likely!, ctx);
    expect(reasons[0]).toBe('Appointment scheduled 10:30–11:15 with Dr Test');
    expect(reasons).toContain('The current time falls inside this appointment');
    expect(reasons).toContain('Booked in Surgery 2, the surgery selected on this computer');
  });

  it('treats Dentally "In surgery" as a strong signal, including a patient taken in a little early', () => {
    const early = appt('10:30', '11:00', { state: 'In surgery' });
    const r = predictLikelyPatient({ nowMs: at('10:22'), practitionerId: DR, appointments: [early] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.confidence).toBe('HIGH');
    expect(r.likely?.signals[0]?.code).toBe('IN_SURGERY_STATE');
  });

  it('does not believe "In surgery" set long before the appointment starts', () => {
    const implausible = appt('12:30', '13:00', { state: 'In surgery' });
    const r = predictLikelyPatient({ nowMs: at('10:00'), practitionerId: DR, appointments: [implausible] });
    expect(r.status).toBe('NONE');
    expect(r.likely).toBeNull();
  });

  it('returns AMBIGUOUS with no default when two patients are booked at the same time', () => {
    const a = appt('10:30', '11:00');
    const b = appt('10:30', '11:00');
    const r = predictLikelyPatient({ nowMs: at('10:35'), practitionerId: DR, appointments: [a, b] });
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.likely).toBeNull();
    expect(r.choices.map((c) => c.appointment.appointmentId).sort()).toEqual([a.appointmentId, b.appointmentId].sort());
    expect(r.warnings.find((w) => w.code === 'DOUBLE_BOOKED')).toBeTruthy();
    expect(explainWarning(r.warnings.find((w) => w.code === 'DOUBLE_BOOKED')!)).toMatch(/Check who is in the chair/);
  });

  it('returns AMBIGUOUS when the previous appointment overruns into the next, listing the overrunning patient first', () => {
    const previous = appt('10:00', '10:30', { state: 'In surgery' });
    const next = appt('10:30', '11:00', { state: 'Arrived' });
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: [next, previous] });
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.candidates[0]?.appointment.appointmentId).toBe(previous.appointmentId);
    expect(r.warnings.map((w) => w.code)).toContain('PREVIOUS_STILL_IN_SURGERY');
    const reasons = explainCandidate(r.candidates[0]!, ctx);
    expect(reasons).toContain('Was due to finish at 10:30 (10 minutes ago) and is not marked completed');
  });

  it('treats an "In surgery" status left on 30 to 120 minutes after the finish as possibly stale: suggests the current patient, but only with MEDIUM confidence and a warning', () => {
    const forgotten = appt('09:00', '09:30', { state: 'In surgery' });
    const current = appt('10:30', '11:00');
    const r = predictLikelyPatient({ nowMs: at('10:35'), practitionerId: DR, appointments: [forgotten, current] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.appointment.appointmentId).toBe(current.appointmentId);
    expect(r.likely?.confidence).toBe('MEDIUM');
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['STALE_IN_SURGERY', 'PREVIOUS_NOT_FINISHED']));
    const ctxW = { timeZone: 'Europe/London', appointments: [forgotten, current] };
    expect(explainWarning(r.warnings.find((w) => w.code === 'STALE_IN_SURGERY')!, ctxW)).toBe(
      'The 09:00–09:30 appointment is still marked In surgery long after it was due to finish.',
    );
  });

  it('ignores an "In surgery" status left on for more than two hours (never updated)', () => {
    const ancient = appt('08:00', '08:30', { state: 'In surgery' });
    const current = appt('10:30', '11:00');
    const r = predictLikelyPatient({ nowMs: at('10:35'), practitionerId: DR, appointments: [ancient, current] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.confidence).toBe('HIGH');
    expect(r.warnings).toEqual([]);
  });

  it('caps confidence and warns when the previous appointment is not marked completed (possible overrun)', () => {
    const previous = appt('10:00', '10:30', { state: 'Arrived' });
    const current = appt('10:30', '11:00');
    const r = predictLikelyPatient({ nowMs: at('10:35'), practitionerId: DR, appointments: [previous, current] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.appointment.appointmentId).toBe(current.appointmentId);
    expect(r.likely?.confidence).toBe('MEDIUM');
    const w = r.warnings.find((x) => x.code === 'PREVIOUS_NOT_FINISHED')!;
    expect(w.appointmentIds).toEqual([previous.appointmentId]);
    expect(explainWarning(w, { timeZone: 'Europe/London', appointments: [previous, current] })).toBe(
      'The 10:00–10:30 appointment is not marked completed in Dentally and may still be running. Check who is in the chair.',
    );
  });

  it('offers a not-yet-completed overrunning appointment with MEDIUM confidence between appointments', () => {
    const previous = appt('10:00', '10:30');
    const later = appt('11:00', '11:30');
    const r = predictLikelyPatient({ nowMs: at('10:45'), practitionerId: DR, appointments: [previous, later] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.appointment.appointmentId).toBe(previous.appointmentId);
    expect(r.likely?.confidence).toBe('MEDIUM');
  });

  it('becomes AMBIGUOUS when an overrunning appointment and one starting soon compete', () => {
    const previous = appt('10:00', '10:30');
    const later = appt('11:00', '11:30');
    const r = predictLikelyPatient({ nowMs: at('10:52'), practitionerId: DR, appointments: [previous, later] });
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.warnings.map((w) => w.code)).toContain('MULTIPLE_CANDIDATES');
  });

  it('suggests an appointment starting within 10 minutes with MEDIUM confidence', () => {
    const soon = appt('10:30', '11:00');
    const r = predictLikelyPatient({ nowMs: at('10:25'), practitionerId: DR, appointments: [soon] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.confidence).toBe('MEDIUM');
    expect(explainCandidate(r.likely!, ctx)).toContain('Starts in 5 minutes');
  });

  it('returns NONE with the next appointment when nothing is current', () => {
    const morning = appt('09:00', '09:30', { state: 'Completed' });
    const afternoon = appt('14:00', '14:30');
    const r = predictLikelyPatient({ nowMs: at('13:00'), practitionerId: DR, appointments: [morning, afternoon] });
    expect(r.status).toBe('NONE');
    expect(r.nextAppointment?.appointmentId).toBe(afternoon.appointmentId);
  });

  it('never suggests cancelled, did-not-attend, completed or patient-less appointments', () => {
    const appts = [
      appt('10:30', '11:00', { state: 'Cancelled' }),
      appt('10:30', '11:00', { state: 'Did not attend' }),
      appt('10:30', '11:00', { state: 'Completed' }),
      appt('10:30', '11:00', { patientId: null, patientName: null }),
    ];
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: appts });
    expect(r.status).toBe('NONE');
    expect(r.candidates).toHaveLength(0);
  });

  it('ignores other clinicians\' appointments', () => {
    const theirs = appt('10:30', '11:00', { practitionerId: OTHER_DR });
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: [theirs] });
    expect(r.status).toBe('NONE');
  });

  it('lowers confidence and explains when the appointment is booked in a different surgery', () => {
    const elsewhere = appt('10:30', '11:00', { roomId: 'room-3' });
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, roomId: 'room-2', appointments: [elsewhere] });
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.confidence).toBe('MEDIUM');
    expect(r.warnings.map((w) => w.code)).toContain('ROOM_MISMATCH');
    expect(explainCandidate(r.likely!, ctx)).toContain('Booked in Surgery 3, not Surgery 2');
  });

  it('lowers confidence for an unrecognised Dentally state, and refuses to suggest when combined with a surgery mismatch', () => {
    const odd = appt('10:30', '11:00', { state: 'Unknown', rawState: 'Ready for checkout' });
    const r1 = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: [odd] });
    expect(r1.status).toBe('LIKELY');
    expect(r1.likely?.confidence).toBe('MEDIUM');
    expect(explainCandidate(r1.likely!, ctx).join(' ')).toContain('"Ready for checkout"');

    const oddElsewhere = appt('10:30', '11:00', { state: 'Unknown', roomId: 'room-3' });
    const later = appt('11:00', '11:30');
    const r2 = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, roomId: 'room-2', appointments: [oddElsewhere, later] });
    // Never "no appointment now, here is the next patient" while a current appointment exists: the user must check it.
    expect(r2.status).toBe('AMBIGUOUS');
    expect(r2.choices.map((c) => c.appointment.appointmentId)).toEqual([oddElsewhere.appointmentId]);
    expect(r2.warnings.map((w) => w.code)).toContain('NEEDS_CHECK');
  });

  it('does not suggest an appointment already finished with in AuraNoteTaker, and moves on to the next one', () => {
    const done = appt('10:30', '11:15');
    const next = appt('11:15', '12:00');
    const r = predictLikelyPatient({
      nowMs: at('10:55'),
      practitionerId: DR,
      appointments: [done, next],
      excludeAppointmentIds: [done.appointmentId],
    });
    expect(r.status).toBe('NONE');
    expect(r.nextAppointment?.appointmentId).toBe(next.appointmentId);
  });

  it('drops every copy of an appointment ID that Dentally returns with different bookings', () => {
    const real = appt('10:30', '11:00');
    const clash = { ...real, patientId: 'p-other', patientName: 'Someone Else' };
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: [real, clash] });
    expect(r.status).toBe('NONE');
    expect(r.candidates).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toContain('CONFLICTING_DUPLICATE');
  });

  it('ignores duplicated entries and appointments with unreadable times, with warnings', () => {
    const current = appt('10:30', '11:00');
    const broken = appt('11:00', '10:00');
    const r = predictLikelyPatient({ nowMs: at('10:40'), practitionerId: DR, appointments: [current, { ...current }, broken] });
    expect(r.status).toBe('LIKELY');
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['DUPLICATE_APPOINTMENT', 'INVALID_APPOINTMENT_TIMES']));
  });

  it('gives the same answer whatever order the diary arrives in', () => {
    const appts = [appt('09:00', '09:30'), appt('10:00', '10:30', { state: 'In surgery' }), appt('10:30', '11:00'), appt('11:00', '11:30')];
    const now = at('10:35');
    const expected = predictLikelyPatient({ nowMs: now, practitionerId: DR, appointments: appts });
    for (let i = 0; i < 10; i += 1) {
      const shuffled = [...appts].sort(() => Math.random() - 0.5);
      const r = predictLikelyPatient({ nowMs: now, practitionerId: DR, appointments: shuffled });
      expect(r.status).toBe(expected.status);
      expect(r.candidates.map((c) => c.appointment.appointmentId)).toEqual(expected.candidates.map((c) => c.appointment.appointmentId));
    }
  });

  it('works across the October clock change (BST to GMT)', () => {
    // 25 October 2026: clocks go back at 02:00 BST. A 09:00 appointment that day is 09:00 GMT (UTC+0).
    const a: DiaryAppointment = { ...appt('09:00', '09:30'), startMs: at('09:00', '2026-10-25', 'Z'), finishMs: at('09:30', '2026-10-25', 'Z') };
    const r = predictLikelyPatient({ nowMs: at('09:10', '2026-10-25', 'Z'), practitionerId: DR, appointments: [a] });
    expect(r.status).toBe('LIKELY');
    expect(explainCandidate(r.likely!, ctx)[0]).toBe('Appointment scheduled 09:00–09:30 with Dr Test');
  });

  it('works across the March clock change (GMT to BST)', () => {
    // 29 March 2026: clocks go forward at 01:00 GMT. A 09:00 appointment that day is 09:00 BST (UTC+1).
    const a: DiaryAppointment = { ...appt('09:00', '09:30'), startMs: at('09:00', '2026-03-29', '+01:00'), finishMs: at('09:30', '2026-03-29', '+01:00') };
    const r = predictLikelyPatient({ nowMs: at('08:10', '2026-03-29', 'Z'), practitionerId: DR, appointments: [a] });
    expect(r.status).toBe('LIKELY');
    expect(explainCandidate(r.likely!, ctx)[0]).toBe('Appointment scheduled 09:00–09:30 with Dr Test');
  });
});
