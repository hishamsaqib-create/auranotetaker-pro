import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PRACTITIONERS, DEMO_ROOMS, MockDentallyService } from '../dentally/mock.ts';
import type { DemoScenario } from '../dentally/mock.ts';
import { AppError } from './errors.ts';
import {
  cancelSession,
  confirmPatient,
  DIARY_AUDIT_WINDOW_MS,
  getActiveSession,
  getDentallyStatus,
  getDiary,
  getPatientSummary,
  getSessionPatient,
  recordConsent,
} from './handlers.ts';
import { InMemoryAuditSink, InMemorySessionRepository, StaticClinicDirectory } from './memory.ts';
import type { HandlerDeps, SessionRepository, StaffContext } from './ports.ts';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const DAY_MS = 24 * 60 * 60 * 1000;
const CLINIC = 'clinic-aura';

const nurse: StaffContext = { email: 'nurse@aura.test', displayName: 'Nurse Test', clinicId: CLINIC, roles: ['NURSE'], clinicianId: null, deviceId: 'dev-1' };
const otherNurse: StaffContext = { ...nurse, email: 'nurse2@aura.test' };
const dentist: StaffContext = { ...nurse, email: 'lin@aura.test', roles: ['DENTIST'], clinicianId: 'DEMO-PR1' };
const manager: StaffContext = { ...nurse, email: 'pm@aura.test', roles: ['CLINIC_ADMIN'] };
const auditor: StaffContext = { ...nurse, email: 'auditor@aura.test', roles: ['AUDITOR'] };
const otherClinic: StaffContext = { ...nurse, email: 'x@other.test', clinicId: 'clinic-other' };

let ids = 0;
let sessions: InMemorySessionRepository;
let auditSink: InMemoryAuditSink;
let mock: MockDentallyService;

function deps(scenario: DemoScenario = 'normal', opts: { clock?: () => number; anchorMs?: number; repo?: SessionRepository } = {}): HandlerDeps {
  const clock = opts.clock ?? (() => NOW);
  mock = new MockDentallyService({ clock, scenario, anchorMs: opts.anchorMs ?? NOW });
  return {
    clock,
    newId: () => `session-${++ids}`,
    clinic: { clinicId: CLINIC, name: 'Aura Dental Clinic', timeZone: 'Europe/London', dentallySiteId: null, settings: { earlyStartMinutes: 10, overrunMinutes: 30 } },
    dentally: mock,
    sessions: opts.repo ?? sessions,
    audit: auditSink,
    directory: new StaticClinicDirectory(
      CLINIC,
      DEMO_PRACTITIONERS.map((p) => ({ practitionerId: p.practitionerId, displayName: p.displayName, clinicianType: 'DENTIST' as const })),
      DEMO_ROOMS.map((r, i) => ({ surgeryId: `surgery-${i + 1}`, name: r.name, roomId: r.roomId })),
    ),
  };
}

// DEMO-A04 (Oliver Bennett, DEMO-P1001) is in surgery with Dr Sarah Lin (DEMO-PR1) in Surgery 1 at NOW.
const confirmInput = {
  appointmentId: 'DEMO-A04',
  patientId: 'DEMO-P1001',
  practitionerId: 'DEMO-PR1',
  surgeryId: 'surgery-1',
  predictedAppointmentId: 'DEMO-A04',
  method: 'CONFIRMED_SUGGESTION',
};
const amara = { ...confirmInput, appointmentId: 'DEMO-A05', patientId: 'DEMO-P1002', method: 'CHOSE_FROM_DIARY' };

async function expectAppError(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

beforeEach(() => {
  sessions = new InMemorySessionRepository();
  auditSink = new InMemoryAuditSink();
});

describe('getDiary', () => {
  it('returns only the selected clinician\'s appointments for today, sorted, as minimal DTOs with the clinic\'s prediction settings', async () => {
    const r = await getDiary(nurse, deps(), { practitionerId: 'DEMO-PR1' });
    expect(r.date).toBe('2026-10-20');
    expect(new Set(r.appointments.map((a) => a.practitionerId))).toEqual(new Set(['DEMO-PR1']));
    const starts = r.appointments.map((a) => Date.parse(a.startTime));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(Object.keys(r.appointments[0]!).sort()).toEqual(
      ['appointmentId', 'arrivedAt', 'completedAt', 'finishTime', 'inSurgeryAt', 'patientId', 'patientName', 'practitionerId', 'rawState', 'reason', 'roomId', 'startTime', 'state'].sort(),
    );
    expect(r.predictionOptions).toEqual({ earlyStartMinutes: 10, overrunMinutes: 30 });
    expect(r.fetchedAt).toBe(new Date(NOW).toISOString());
  });

  it('audits views on the server\'s terms: once per window, whatever the client says', async () => {
    let t = NOW;
    const d = deps('normal', { clock: () => t });
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'REFRESH' });
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'MANUAL' });
    expect(auditSink.events.filter((e) => e.action === 'DIARY_VIEWED')).toHaveLength(1);
    t = NOW + DIARY_AUDIT_WINDOW_MS + 60_000;
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'REFRESH' });
    expect(auditSink.events.filter((e) => e.action === 'DIARY_VIEWED')).toHaveLength(2);
  });

  it('refuses clinicians that are not configured', async () => {
    await expectAppError(getDiary(nurse, deps(), { practitionerId: 'PR-UNKNOWN' }), 'VALIDATION');
  });

  it('refuses roles without clinical access and records the denial', async () => {
    await expectAppError(getDiary(auditor, deps(), { practitionerId: 'DEMO-PR1' }), 'FORBIDDEN');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'ACCESS_DENIED', details: { operation: 'getDiary', reasonCode: 'ROLE' } });
  });

  it('refuses callers from another clinic', async () => {
    await expectAppError(getDiary(otherClinic, deps(), { practitionerId: 'DEMO-PR1' }), 'FORBIDDEN');
  });

  it('reports Dentally being unavailable clearly', async () => {
    await expectAppError(getDiary(nurse, deps('dentally-offline'), { practitionerId: 'DEMO-PR1' }), 'DENTALLY_UNAVAILABLE');
  });

  it('reports which appointments the patient already declined, so they survive a page refresh', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: false, expectedVersion: session.version, surgeryId: 'surgery-1' });
    const r = await getDiary(nurse, d, { practitionerId: 'DEMO-PR1' });
    expect(r.scribeOutcomes).toEqual({ 'DEMO-A04': 'DECLINED' });
  });
});

describe('getPatientSummary', () => {
  it('returns name, date of birth and patient ID for a patient on today\'s diary, and audits the view without the name', async () => {
    const r = await getPatientSummary(nurse, deps(), { appointmentId: 'DEMO-A04' });
    expect(r).toEqual({ appointmentId: 'DEMO-A04', patientId: 'DEMO-P1001', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' });
    expect(auditSink.events.find((e) => e.action === 'PATIENT_VIEWED')).toMatchObject({ dentallyPatientId: 'DEMO-P1001', details: { purpose: 'IDENTITY_CHECK' } });
    expect(JSON.stringify(auditSink.events)).not.toMatch(/Oliver|Bennett|1986-03-12/);
  });

  it('has no answer for diary entries without a patient', async () => {
    await expectAppError(getPatientSummary(nurse, deps(), { appointmentId: 'DEMO-A07' }), 'NOT_FOUND');
  });
});

describe('confirmPatient', () => {
  it('creates a session with the patient locked, returns the identity it verified, and records predicted versus chosen', async () => {
    const { session, patient } = await confirmPatient(nurse, deps(), confirmInput);
    expect(patient).toEqual({ patientId: 'DEMO-P1001', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' });
    expect(session).toMatchObject({
      status: 'PATIENT_CONFIRMED',
      clinicianId: 'DEMO-PR1',
      surgeryId: 'surgery-1',
      patient: { dentallyPatientId: 'DEMO-P1001', appointment: { appointmentId: 'DEMO-A04', stateAtConfirmation: 'In surgery' } },
      confirmation: { method: 'CONFIRMED_SUGGESTION', matchedPrediction: true, confirmedBy: 'nurse@aura.test' },
      consent: { status: 'PENDING' },
    });
    expect(auditSink.events.find((e) => e.action === 'PATIENT_CONFIRMED')).toMatchObject({
      sessionId: session.sessionId,
      details: {
        method: 'CONFIRMED_SUGGESTION',
        predictedAppointmentId: 'DEMO-A04',
        matchedPrediction: true,
        // The server's own prediction, independent of what the client reported.
        serverPredictionStatus: 'LIKELY',
        serverPredictedAppointmentId: 'DEMO-A04',
      },
    });
  });

  it('records when the user chose a different patient from the one suggested', async () => {
    const { session } = await confirmPatient(nurse, deps(), { ...amara, method: 'CHOSE_ALTERNATIVE' });
    expect(session.confirmation.matchedPrediction).toBe(false);
  });

  it('refuses when the appointment is not booked for that patient in Dentally (stale or tampered diary)', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, patientId: 'DEMO-P1002' }), 'PATIENT_MISMATCH');
    expect(sessions.all()).toHaveLength(0);
  });

  it('refuses after Dentally re-books the appointment to someone else', async () => {
    const d = deps();
    mock.rebook('DEMO-A04', 'DEMO-P1009');
    await expectAppError(confirmPatient(nurse, d, confirmInput), 'PATIENT_MISMATCH');
  });

  it('refuses an appointment belonging to another clinician', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, practitionerId: 'DEMO-PR2' }), 'PRACTITIONER_MISMATCH');
  });

  it('refuses cancelled appointments', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, appointmentId: 'DEMO-A08', patientId: 'DEMO-P1008' }), 'APPOINTMENT_CLOSED');
  });

  it('refuses appointments that are not today', async () => {
    await expectAppError(confirmPatient(nurse, deps('normal', { anchorMs: NOW - DAY_MS }), confirmInput), 'NOT_TODAY');
  });

  it('refuses a second open session in the same surgery (no crossover), pointing at the open one', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const err = await expectAppError(confirmPatient(nurse, d, amara), 'ACTIVE_SESSION_EXISTS');
    expect(err.details.sessionId).toBe(session.sessionId);
  });

  it('refuses a second open session for the same clinician in another surgery (dentist changes surgery)', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const err = await expectAppError(confirmPatient(nurse, d, { ...amara, surgeryId: 'surgery-2' }), 'ACTIVE_SESSION_EXISTS');
    expect(err.details.sessionId).toBe(session.sessionId);
    const restored = await getActiveSession(nurse, d, { surgeryId: 'surgery-2', practitionerId: 'DEMO-PR1' });
    expect(restored.session?.patient.dentallyPatientId).toBe('DEMO-P1001');
    expect(restored.restriction).toBe('OTHER_SURGERY');
  });

  it('refuses to open a second session for a patient who already has one elsewhere', async () => {
    const d = deps();
    await confirmPatient(nurse, d, confirmInput);
    await expectAppError(confirmPatient(nurse, d, { ...confirmInput, surgeryId: 'surgery-2' }), 'DUPLICATE_PATIENT_SESSION');
  });

  it('lets only one of two simultaneous confirmations win', async () => {
    const d = deps();
    const results = await Promise.allSettled([
      confirmPatient(nurse, d, confirmInput),
      confirmPatient(otherNurse, d, { ...confirmInput, surgeryId: 'surgery-2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AppError);
    expect(['ACTIVE_SESSION_EXISTS', 'DUPLICATE_PATIENT_SESSION']).toContain(rejected.reason.code);
    expect(sessions.all().filter((s) => s.status === 'PATIENT_CONFIRMED')).toHaveLength(1);
  });

  it('writes the confirmation to the audit trail before the session exists, and records a failed save', async () => {
    let failOnce = true;
    const flaky: SessionRepository = {
      create: async (s) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('storage unavailable');
        }
        return sessions.create(s);
      },
      get: (c, id) => sessions.get(c, id),
      update: (s, v) => sessions.update(s, v),
      findActive: (c, f) => sessions.findActive(c, f),
      findByAppointments: (c, a) => sessions.findByAppointments(c, a),
    };
    const d = deps('normal', { repo: flaky });
    await expect(confirmPatient(nurse, d, confirmInput)).rejects.toThrow('storage unavailable');
    expect(auditSink.events.map((e) => [e.action, e.details.reasonCode ?? null])).toEqual([
      ['PATIENT_CONFIRMED', null],
      ['SESSION_CANCELLED', 'CREATE_FAILED'],
    ]);
    // A retry is not blocked by a half-made session.
    await expect(confirmPatient(nurse, d, confirmInput)).resolves.toMatchObject({ session: { status: 'PATIENT_CONFIRMED' } });
  });

  it('asks for an explicit acknowledgement before re-confirming a patient who declined earlier', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: false, expectedVersion: session.version, surgeryId: 'surgery-1' });
    await expectAppError(confirmPatient(nurse, d, confirmInput), 'PREVIOUS_DECLINE');
    const again = await confirmPatient(nurse, d, { ...confirmInput, acknowledgePreviousDecline: true });
    expect(again.session.status).toBe('PATIENT_CONFIRMED');
    expect(auditSink.events.filter((e) => e.action === 'PATIENT_CONFIRMED').at(-1)?.details.acknowledgedPreviousDecline).toBe(true);
  });

  it('cannot start a session while Dentally is offline, because identity cannot be verified', async () => {
    await expectAppError(confirmPatient(nurse, deps('dentally-offline'), confirmInput), 'DENTALLY_UNAVAILABLE');
    expect(sessions.all()).toHaveLength(0);
  });

  it('validates input', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, method: 'GUESSED' }), 'VALIDATION');
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, appointmentId: '../x' }), 'VALIDATION');
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, surgeryId: 'surgery-99' }), 'VALIDATION');
  });
});

describe('session changes', () => {
  it('a decline ends the session and frees the surgery for the next patient', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const declined = await recordConsent(nurse, d, { sessionId: session.sessionId, given: false, expectedVersion: session.version, surgeryId: 'surgery-1' });
    expect(declined.session.status).toBe('CONSENT_DECLINED');
    expect(auditSink.events.find((e) => e.action === 'CONSENT_RECORDED')).toMatchObject({ details: { given: false, statusBefore: 'PATIENT_CONFIRMED' } });
    const next = await confirmPatient(nurse, d, amara);
    expect(next.session.status).toBe('PATIENT_CONFIRMED');
  });

  it('only the person who confirmed the patient, or the treating clinician, can record the answer', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await expectAppError(recordConsent(otherNurse, d, { sessionId: session.sessionId, given: true, expectedVersion: 1, surgeryId: 'surgery-1' }), 'FORBIDDEN');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'ACCESS_DENIED', details: { reasonCode: 'NOT_SESSION_MEMBER' } });
    const byClinician = await recordConsent(dentist, d, { sessionId: session.sessionId, given: true, expectedVersion: 1, surgeryId: 'surgery-1' });
    expect(byClinician.session.status).toBe('READY');
  });

  it('refuses to record the answer from a different surgery', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await expectAppError(recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: 1, surgeryId: 'surgery-2' }), 'SURGERY_MISMATCH');
  });

  it('lets any clinician or the practice manager cancel a session before recording', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const r = await cancelSession(manager, d, { sessionId: session.sessionId, expectedVersion: session.version });
    expect(r.session.status).toBe('CANCELLED');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'SESSION_CANCELLED', details: { statusBefore: 'PATIENT_CONFIRMED', reasonCode: 'USER_CANCELLED' } });
  });

  it('closes yesterday\'s abandoned session automatically instead of restoring it or letting it block today', async () => {
    const yesterday = NOW - DAY_MS;
    const dYesterday = deps('normal', { clock: () => yesterday, anchorMs: yesterday });
    const { session } = await confirmPatient(nurse, dYesterday, confirmInput);

    const dToday = deps();
    const restored = await getActiveSession(nurse, dToday, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' });
    expect(restored.session).toBeNull();
    expect((await sessions.get(CLINIC, session.sessionId))?.status).toBe('CANCELLED');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'SESSION_STATUS_CHANGED', actorEmail: 'system', details: { reasonCode: 'EXPIRED', to: 'CANCELLED' } });
    await expect(confirmPatient(nurse, dToday, confirmInput)).resolves.toBeTruthy();
  });

  it('rejects changes based on a stale version (two screens editing one session)', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: session.version, surgeryId: 'surgery-1' });
    await expectAppError(cancelSession(nurse, d, { sessionId: session.sessionId, expectedVersion: session.version }), 'VERSION_CONFLICT');
  });

  it('restores the open session after a page refresh, and forgets it once cancelled', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const restored = await getActiveSession(nurse, d, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' });
    expect(restored).toMatchObject({ session: { sessionId: session.sessionId, patient: { dentallyPatientId: 'DEMO-P1001' } }, restriction: null });
    await cancelSession(nurse, d, { sessionId: session.sessionId, expectedVersion: session.version });
    expect((await getActiveSession(nurse, d, { surgeryId: 'surgery-1' })).session).toBeNull();
  });

  it('offers only Cancel for a session this user could not continue from this computer', async () => {
    const d = deps();
    await confirmPatient(nurse, d, confirmInput);
    // A computer with no surgery set (for example at reception) finds the clinician's session in Surgery 1.
    expect(await getActiveSession(otherNurse, d, { surgeryId: null, practitionerId: 'DEMO-PR1' })).toMatchObject({ restriction: 'OTHER_SURGERY' });
    // Another nurse in the same surgery can see it, but cannot answer for the patient.
    expect(await getActiveSession(otherNurse, d, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' })).toMatchObject({ restriction: 'NOT_MEMBER' });
    // The treating clinician can continue it.
    expect(await getActiveSession(dentist, d, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' })).toMatchObject({ restriction: null });
  });

  it('names the session\'s patient by the locked patient ID, even if Dentally re-books the appointment', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    mock.rebook('DEMO-A04', 'DEMO-P1002');
    expect((await getPatientSummary(nurse, d, { appointmentId: 'DEMO-A04' })).displayName).toBe('Amara Nwosu');
    expect(await getSessionPatient(nurse, d, { sessionId: session.sessionId })).toEqual({
      patientId: 'DEMO-P1001',
      displayName: 'Oliver Bennett',
      dateOfBirth: '1986-03-12',
    });
  });

  it('does not reveal sessions that do not exist', async () => {
    await expectAppError(recordConsent(nurse, deps(), { sessionId: 'nope', given: true, expectedVersion: 1 }), 'NOT_FOUND');
  });

  it('never writes patient names or dates of birth into audit events across a full flow', async () => {
    const d = deps();
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1' });
    await getPatientSummary(nurse, d, { appointmentId: 'DEMO-A04' });
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await getSessionPatient(nurse, d, { sessionId: session.sessionId });
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: session.version, surgeryId: 'surgery-1' });
    expect(auditSink.events.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(auditSink.events)).not.toMatch(/Oliver|Bennett|1986|Halo Veneer/);
  });
});

describe('getDentallyStatus', () => {
  it('reports connected and unavailable without patient data', async () => {
    expect((await getDentallyStatus(nurse, deps())).status).toBe('CONNECTED');
    expect((await getDentallyStatus(nurse, deps('dentally-offline'))).status).toBe('UNAVAILABLE');
  });
});
