import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PRACTITIONERS, DEMO_ROOMS, MockDentallyService } from '../dentally/mock.ts';
import type { DemoScenario } from '../dentally/mock.ts';
import { AppError } from './errors.ts';
import {
  cancelSession,
  confirmPatient,
  getActiveSession,
  getDentallyStatus,
  getDiary,
  getPatientSummary,
  recordConsent,
} from './handlers.ts';
import { InMemoryAuditSink, InMemorySessionRepository, StaticClinicDirectory } from './memory.ts';
import type { HandlerDeps, StaffContext } from './ports.ts';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const CLINIC = 'clinic-aura';

const nurse: StaffContext = { email: 'nurse@aura.test', displayName: 'Nurse Test', clinicId: CLINIC, roles: ['NURSE'] , clinicianId: null, deviceId: 'dev-1' };
const auditor: StaffContext = { ...nurse, email: 'auditor@aura.test', roles: ['AUDITOR'] };
const otherClinic: StaffContext = { ...nurse, email: 'x@other.test', clinicId: 'clinic-other' };

let ids = 0;
let sessions: InMemorySessionRepository;
let auditSink: InMemoryAuditSink;
let mock: MockDentallyService;

function deps(scenario: DemoScenario = 'normal', anchorMs = NOW): HandlerDeps {
  mock = new MockDentallyService({ clock: () => NOW, scenario, anchorMs });
  return {
    clock: () => NOW,
    newId: () => `session-${++ids}`,
    clinic: { clinicId: CLINIC, name: 'Aura Dental Clinic', timeZone: 'Europe/London', dentallySiteId: null, settings: { earlyStartMinutes: 10, overrunMinutes: 30 } },
    dentally: mock,
    sessions,
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
  it('returns only the selected clinician\'s appointments for today, sorted, as minimal DTOs', async () => {
    const r = await getDiary(nurse, deps(), { practitionerId: 'DEMO-PR1' });
    expect(r.date).toBe('2026-10-20');
    expect(r.appointments.length).toBeGreaterThan(0);
    expect(new Set(r.appointments.map((a) => a.practitionerId))).toEqual(new Set(['DEMO-PR1']));
    const starts = r.appointments.map((a) => Date.parse(a.startTime));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(Object.keys(r.appointments[0]!).sort()).toEqual(
      ['appointmentId', 'arrivedAt', 'completedAt', 'finishTime', 'inSurgeryAt', 'patientId', 'patientName', 'practitionerId', 'rawState', 'reason', 'roomId', 'startTime', 'state'].sort(),
    );
  });

  it('audits the first load and manual refreshes, not background refreshes', async () => {
    const d = deps();
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'INITIAL' });
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'REFRESH' });
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1', reason: 'MANUAL' });
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
});

describe('getPatientSummary', () => {
  it('returns name and date of birth for a patient on today\'s diary, and audits the view without the name', async () => {
    const r = await getPatientSummary(nurse, deps(), { appointmentId: 'DEMO-A04' });
    expect(r).toEqual({ appointmentId: 'DEMO-A04', patientId: 'DEMO-P1001', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' });
    const event = auditSink.events.find((e) => e.action === 'PATIENT_VIEWED');
    expect(event).toMatchObject({ dentallyPatientId: 'DEMO-P1001', details: { purpose: 'IDENTITY_CHECK' } });
    expect(JSON.stringify(auditSink.events)).not.toMatch(/Oliver|Bennett|1986-03-12/);
  });

  it('has no answer for diary entries without a patient', async () => {
    await expectAppError(getPatientSummary(nurse, deps(), { appointmentId: 'DEMO-A07' }), 'NOT_FOUND');
  });
});

describe('confirmPatient', () => {
  it('creates a session with the patient locked and records predicted versus chosen', async () => {
    const { session } = await confirmPatient(nurse, deps(), confirmInput);
    expect(session).toMatchObject({
      status: 'PATIENT_CONFIRMED',
      clinicId: CLINIC,
      clinicianId: 'DEMO-PR1',
      surgeryId: 'surgery-1',
      patient: { dentallyPatientId: 'DEMO-P1001', appointment: { appointmentId: 'DEMO-A04', stateAtConfirmation: 'In surgery' } },
      confirmation: { method: 'CONFIRMED_SUGGESTION', matchedPrediction: true, confirmedBy: 'nurse@aura.test' },
      consent: { status: 'PENDING' },
    });
    expect(auditSink.events.find((e) => e.action === 'PATIENT_CONFIRMED')).toMatchObject({
      sessionId: session.sessionId,
      dentallyPatientId: 'DEMO-P1001',
      details: { method: 'CONFIRMED_SUGGESTION', predictedAppointmentId: 'DEMO-A04', matchedPrediction: true },
    });
  });

  it('records when the user chose a different patient from the one suggested', async () => {
    const { session } = await confirmPatient(nurse, deps(), {
      ...confirmInput,
      appointmentId: 'DEMO-A05',
      patientId: 'DEMO-P1002',
      method: 'CHOSE_ALTERNATIVE',
    });
    expect(session.confirmation.matchedPrediction).toBe(false);
  });

  it('refuses when the appointment is not booked for that patient in Dentally (stale or tampered diary)', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, patientId: 'DEMO-P1002' }), 'PATIENT_MISMATCH');
    expect(sessions.all()).toHaveLength(0);
  });

  it('refuses an appointment belonging to another clinician', async () => {
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, practitionerId: 'DEMO-PR2' }), 'PRACTITIONER_MISMATCH');
  });

  it('refuses cancelled appointments', async () => {
    await expectAppError(
      confirmPatient(nurse, deps(), { ...confirmInput, appointmentId: 'DEMO-A08', patientId: 'DEMO-P1008' }),
      'APPOINTMENT_CLOSED',
    );
  });

  it('refuses appointments that are not today', async () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    await expectAppError(confirmPatient(nurse, deps('normal', yesterday), confirmInput), 'NOT_TODAY');
  });

  it('refuses a second open session in the same surgery (no crossover), pointing at the open one', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const err = await expectAppError(
      confirmPatient(nurse, d, { ...confirmInput, appointmentId: 'DEMO-A05', patientId: 'DEMO-P1002', method: 'CHOSE_FROM_DIARY' }),
      'ACTIVE_SESSION_EXISTS',
    );
    expect(err.details.sessionId).toBe(session.sessionId);
  });

  it('refuses a second open session for the same clinician in another surgery (dentist changes surgery)', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const err = await expectAppError(
      confirmPatient(nurse, d, { ...confirmInput, surgeryId: 'surgery-2', appointmentId: 'DEMO-A05', patientId: 'DEMO-P1002', method: 'CHOSE_FROM_DIARY' }),
      'ACTIVE_SESSION_EXISTS',
    );
    expect(err.details.sessionId).toBe(session.sessionId);
    // From the new surgery, the clinician's open session is found and restored with its original patient.
    const restored = await getActiveSession(nurse, d, { surgeryId: 'surgery-2', practitionerId: 'DEMO-PR1' });
    expect(restored.session?.patient.dentallyPatientId).toBe('DEMO-P1001');
    expect(restored.session?.surgeryId).toBe('surgery-1');
  });

  it('refuses to open a second session for a patient who already has one elsewhere', async () => {
    const d = deps();
    await confirmPatient(nurse, d, confirmInput);
    await expectAppError(confirmPatient(nurse, d, { ...confirmInput, surgeryId: 'surgery-2' }), 'DUPLICATE_PATIENT_SESSION');
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
    const declined = await recordConsent(nurse, d, { sessionId: session.sessionId, given: false, expectedVersion: session.version });
    expect(declined.session.status).toBe('CONSENT_DECLINED');
    expect(auditSink.events.find((e) => e.action === 'CONSENT_RECORDED')).toMatchObject({ details: { given: false, statusBefore: 'PATIENT_CONFIRMED' } });
    const next = await confirmPatient(nurse, d, { ...confirmInput, appointmentId: 'DEMO-A05', patientId: 'DEMO-P1002', method: 'CHOSE_FROM_DIARY' });
    expect(next.session.status).toBe('PATIENT_CONFIRMED');
  });

  it('rejects changes based on a stale version (two screens editing one session)', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: session.version });
    await expectAppError(cancelSession(nurse, d, { sessionId: session.sessionId, expectedVersion: session.version }), 'VERSION_CONFLICT');
  });

  it('restores the open session after a page refresh, and forgets it once cancelled', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const restored = await getActiveSession(nurse, d, { surgeryId: 'surgery-1' });
    expect(restored.session?.sessionId).toBe(session.sessionId);
    expect(restored.session?.patient.dentallyPatientId).toBe('DEMO-P1001');
    await cancelSession(nurse, d, { sessionId: session.sessionId, expectedVersion: session.version });
    expect((await getActiveSession(nurse, d, { surgeryId: 'surgery-1' })).session).toBeNull();
  });

  it('does not reveal sessions that do not exist', async () => {
    await expectAppError(recordConsent(nurse, deps(), { sessionId: 'nope', given: true, expectedVersion: 1 }), 'NOT_FOUND');
  });

  it('never writes patient names or dates of birth into audit events across a full flow', async () => {
    const d = deps();
    await getDiary(nurse, d, { practitionerId: 'DEMO-PR1' });
    await getPatientSummary(nurse, d, { appointmentId: 'DEMO-A04' });
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: session.version });
    expect(auditSink.events.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(auditSink.events)).not.toMatch(/Oliver|Bennett|1986|Halo Veneer/);
  });
});

describe('getDentallyStatus', () => {
  it('reports connected and unavailable without patient data', async () => {
    expect((await getDentallyStatus(nurse, deps())).status).toBe('CONNECTED');
    expect((await getDentallyStatus(nurse, deps('dentally-offline'))).status).toBe('UNAVAILABLE');
  });
});
