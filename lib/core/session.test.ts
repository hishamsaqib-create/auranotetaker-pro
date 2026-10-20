import { describe, expect, it } from 'vitest';
import type { ScribeSession, SessionEvent, SessionPatient } from './session.ts';
import { canCancel, createSession, detectSessionOverrun, isTerminal, transition } from './session.ts';

const T0 = Date.parse('2026-10-20T10:30:00+01:00');
const MIN = 60_000;

const patientA: SessionPatient = {
  dentallyPatientId: 'p-A',
  appointment: { appointmentId: 'a-A', practitionerId: 'pr-1', roomId: 'room-2', startMs: T0, finishMs: T0 + 45 * MIN, reason: 'Exam', stateAtConfirmation: 'Arrived' },
};
const patientB: SessionPatient = {
  dentallyPatientId: 'p-B',
  appointment: { appointmentId: 'a-B', practitionerId: 'pr-1', roomId: 'room-2', startMs: T0 + 45 * MIN, finishMs: T0 + 90 * MIN, reason: 'Review', stateAtConfirmation: 'Confirmed' },
};

const by = 'nurse@aura.test';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<SessionEvent, 'by' | 'atMs'>;

function newSession(): ScribeSession {
  return createSession({
    sessionId: 's-1',
    clinicId: 'clinic-aura',
    clinicianId: 'pr-1',
    surgeryId: 'surgery-2',
    patient: patientA,
    method: 'CONFIRMED_SUGGESTION',
    predictedAppointmentId: 'a-A',
    confirmedBy: by,
    atMs: T0,
  });
}

function apply(s: ScribeSession, ...events: EventInput[]): ScribeSession {
  let cur = s;
  for (const e of events) {
    const r = transition(cur, { by, atMs: T0 + MIN, ...e } as SessionEvent);
    if (!r.ok) throw new Error(`${e.type} failed: ${r.code}`);
    cur = r.session;
  }
  return cur;
}

const ALL_EVENTS: EventInput[] = [
  { type: 'RECORD_CONSENT', given: true },
  { type: 'RECORD_CONSENT', given: false },
  { type: 'START_RECORDING' },
  { type: 'PAUSE' },
  { type: 'RESUME' },
  { type: 'STOP' },
  { type: 'BEGIN_GENERATION' },
  { type: 'GENERATION_SUCCEEDED' },
  { type: 'GENERATION_FAILED' },
  { type: 'REGENERATE' },
  { type: 'APPROVE' },
  { type: 'DISCARD', reason: 'wrong template' },
  { type: 'CANCEL' },
  { type: 'EXPIRE' },
];

describe('scribe session', () => {
  it('starts PATIENT_CONFIRMED with the patient locked, permission pending and the prediction match recorded', () => {
    const s = newSession();
    expect(s.status).toBe('PATIENT_CONFIRMED');
    expect(s.patient.dentallyPatientId).toBe('p-A');
    expect(s.consent.status).toBe('PENDING');
    expect(s.confirmation.matchedPrediction).toBe(true);
    expect(s.version).toBe(1);
  });

  it('refuses to record until the patient\'s permission is recorded', () => {
    const r = transition(newSession(), { type: 'START_RECORDING', by, atMs: T0 });
    expect(r).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED' });
  });

  it('ends the session with no recording when the patient declines the AI scribe', () => {
    const s = apply(newSession(), { type: 'RECORD_CONSENT', given: false });
    expect(s.status).toBe('CONSENT_DECLINED');
    expect(s.consent).toMatchObject({ status: 'DECLINED', recordedBy: by });
    expect(isTerminal(s.status)).toBe(true);
    expect(transition(s, { type: 'START_RECORDING', by, atMs: T0 })).toMatchObject({ ok: false, code: 'TERMINAL' });
  });

  it('treats a mid-recording withdrawal of permission as terminal', () => {
    const s = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' }, { type: 'RECORD_CONSENT', given: false });
    expect(s.status).toBe('CONSENT_DECLINED');
  });

  it('runs the happy path to approval, bumping the version and recording history', () => {
    const s = apply(
      newSession(),
      { type: 'RECORD_CONSENT', given: true },
      { type: 'START_RECORDING' },
      { type: 'PAUSE' },
      { type: 'RESUME' },
      { type: 'STOP' },
      { type: 'BEGIN_GENERATION' },
      { type: 'GENERATION_SUCCEEDED' },
      { type: 'APPROVE' },
    );
    expect(s.status).toBe('APPROVED');
    expect(s.version).toBe(9);
    expect(s.statusHistory.map((h) => h.status)).toEqual([
      'PATIENT_CONFIRMED', 'READY', 'RECORDING', 'PAUSED', 'RECORDING', 'STOPPED', 'GENERATING', 'IN_REVIEW', 'APPROVED',
    ]);
    expect(s.recordingStartedAtMs).not.toBeNull();
    expect(s.recordingStoppedAtMs).not.toBeNull();
  });

  it('never changes the patient through any event other than an explicit reassignment', () => {
    // Walk every reachable status and fire every non-reassignment event at it.
    const reachable: ScribeSession[] = [newSession()];
    const seen = new Set<string>([reachable[0]!.status]);
    for (let i = 0; i < reachable.length; i += 1) {
      for (const e of ALL_EVENTS) {
        const r = transition(reachable[i]!, { by, atMs: T0 + MIN, ...e } as SessionEvent);
        if (!r.ok) continue;
        expect(r.session.patient).toEqual(patientA);
        if (!seen.has(r.session.status)) {
          seen.add(r.session.status);
          reachable.push(r.session);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('does not mutate the session it is given', () => {
    const s = newSession();
    const snapshot = structuredClone(s);
    transition(s, { type: 'RECORD_CONSENT', given: true, by, atMs: T0 });
    transition(s, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient selected', by, atMs: T0 });
    expect(s).toEqual(snapshot);
  });

  it('accepts no events once terminal', () => {
    const cancelled = apply(newSession(), { type: 'CANCEL' });
    for (const e of ALL_EVENTS) {
      expect(transition(cancelled, { by, atMs: T0, ...e } as SessionEvent).ok).toBe(false);
    }
  });

  describe('reassignment', () => {
    it('requires a reason', () => {
      const r = transition(newSession(), { type: 'REASSIGN_PATIENT', to: patientB, reason: ' ', by, atMs: T0 });
      expect(r).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    });

    it('before recording: changes the patient, records the reassignment and asks for permission again', () => {
      const ready = apply(newSession(), { type: 'RECORD_CONSENT', given: true });
      const r = transition(ready, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient selected', by, atMs: T0 + MIN });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.session.patient.dentallyPatientId).toBe('p-B');
      expect(r.session.status).toBe('PATIENT_CONFIRMED');
      expect(r.session.consent.status).toBe('PENDING');
      expect(r.session.reassignments).toEqual([
        expect.objectContaining({ fromPatientId: 'p-A', toPatientId: 'p-B', reason: 'Wrong patient selected', consentCarriedOver: false }),
      ]);
    });

    it('is refused while recording', () => {
      const recording = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' });
      const r = transition(recording, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient', by, atMs: T0 });
      expect(r).toMatchObject({ ok: false, code: 'REASSIGN_WHILE_RECORDING' });
    });

    it('after recording: needs confirmation that permission came from the corrected patient', () => {
      const paused = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' }, { type: 'PAUSE' });
      const refused = transition(paused, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient', by, atMs: T0 });
      expect(refused).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED' });
      const r = transition(paused, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient', consentConfirmedForNewPatient: true, by, atMs: T0 });
      expect(r.ok && r.session.patient.dentallyPatientId).toBe('p-B');
      expect(r.ok && r.session.status).toBe('PAUSED');
      expect(r.ok && r.session.reassignments[0]?.consentCarriedOver).toBe(true);
    });

    it('during review: supersedes the draft so it must be regenerated for the corrected patient', () => {
      const review = apply(
        newSession(),
        { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' }, { type: 'STOP' },
        { type: 'BEGIN_GENERATION' }, { type: 'GENERATION_SUCCEEDED' },
      );
      const r = transition(review, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient', consentConfirmedForNewPatient: true, by, atMs: T0 });
      expect(r.ok && r.session.status).toBe('STOPPED');
      expect(r.ok && r.session.patient.dentallyPatientId).toBe('p-B');
    });

    it('is refused after approval', () => {
      const approved = apply(
        newSession(),
        { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' }, { type: 'STOP' },
        { type: 'BEGIN_GENERATION' }, { type: 'GENERATION_SUCCEEDED' }, { type: 'APPROVE' },
      );
      const r = transition(approved, { type: 'REASSIGN_PATIENT', to: patientB, reason: 'Wrong patient', consentConfirmedForNewPatient: true, by, atMs: T0 });
      expect(r).toMatchObject({ ok: false, code: 'REASSIGN_AFTER_APPROVAL' });
    });

    it('is refused when the patient is unchanged', () => {
      const r = transition(newSession(), { type: 'REASSIGN_PATIENT', to: patientA, reason: 'Checking', by, atMs: T0 });
      expect(r).toMatchObject({ ok: false, code: 'SAME_PATIENT' });
    });
  });

  it('requires a reason to discard and only allows it after stopping', () => {
    const recording = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' });
    expect(transition(recording, { type: 'DISCARD', reason: 'test run', by, atMs: T0 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    const stopped = apply(recording, { type: 'STOP' });
    expect(transition(stopped, { type: 'DISCARD', reason: '', by, atMs: T0 })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(transition(stopped, { type: 'DISCARD', reason: 'test run', by, atMs: T0 })).toMatchObject({ ok: true });
  });
});

describe('expiry', () => {
  it('closes a session with nothing recorded, but never one that has recordings', () => {
    expect(apply(newSession(), { type: 'EXPIRE' }).status).toBe('CANCELLED');
    const recording = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' });
    expect(transition(recording, { type: 'EXPIRE', by: 'system', atMs: T0 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });
});

describe('detectSessionOverrun (forgotten stop)', () => {
  const recording = apply(newSession(), { type: 'RECORD_CONSENT', given: true }, { type: 'START_RECORDING' });
  const next = { appointmentId: 'a-B', startMs: T0 + 45 * MIN, patientId: 'p-B' };

  it('says nothing during the appointment', () => {
    expect(detectSessionOverrun(recording, T0 + 30 * MIN, next)).toBeNull();
  });

  it('warns when the next patient\'s appointment has started, without changing the session', () => {
    const w = detectSessionOverrun(recording, T0 + 52 * MIN, next);
    expect(w).toEqual({ code: 'NEXT_APPOINTMENT_STARTED', nextAppointmentId: 'a-B', minutesSinceNextStart: 7 });
    expect(recording.patient.dentallyPatientId).toBe('p-A');
  });

  it('warns when recording runs well past the appointment end with no next appointment', () => {
    expect(detectSessionOverrun(recording, T0 + 60 * MIN, null)).toEqual({ code: 'PAST_APPOINTMENT_END', minutesPastEnd: 15 });
  });

  it('only applies while recording or paused', () => {
    const stopped = apply(recording, { type: 'STOP' });
    expect(detectSessionOverrun(stopped, T0 + 120 * MIN, next)).toBeNull();
  });
});

describe('canCancel', () => {
  it('agrees with the state machine for every status, so the screen never offers a cancel it would refuse', () => {
    const statuses: ScribeSession['status'][] = [
      'PATIENT_CONFIRMED', 'CONSENT_DECLINED', 'READY', 'RECORDING', 'PAUSED', 'STOPPED', 'GENERATING', 'IN_REVIEW', 'APPROVED', 'DISCARDED', 'CANCELLED',
    ];
    for (const status of statuses) {
      const r = transition({ ...newSession(), status }, { type: 'CANCEL', by, atMs: T0 + MIN });
      expect(canCancel(status), status).toBe(r.ok);
    }
  });
});
