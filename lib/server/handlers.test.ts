import { beforeEach, describe, expect, it } from 'vitest';
import { isTerminal } from '../core/session.ts';
import { DEMO_PRACTITIONERS, DEMO_ROOMS, MockDentallyService } from '../dentally/mock.ts';
import type { DemoScenario } from '../dentally/mock.ts';
import { AppError } from './errors.ts';
import {
  ABANDONED_AFTER_MS,
  cancelSession,
  changeRecording,
  confirmPatient,
  getScribeContent,
  getSpeechToken,
  saveNurseNote,
  saveTranscript,
  DIARY_AUDIT_WINDOW_MS,
  getActiveSession,
  getDentallyStatus,
  getDiary,
  getPatientSummary,
  getClinicSetup,
  getDentallyCheck,
  listNoteTemplates,
  recordNoteCopied,
  saveNoteTemplate,
  getSessionPatient,
  recordConsent,
  saveClinicians,
  saveStaffProfile,
  saveSurgeries,
} from './handlers.ts';
import { AesGcmContentCipher } from './cipher.ts';
import { DemoSpeechTokenIssuer, InMemoryAuditSink, InMemoryScribeContentStore, InMemorySessionRepository, StaticClinicDirectory } from './memory.ts';
import type { HandlerDeps, SessionRepository, SpeechTokenIssuer, StaffContext } from './ports.ts';
import { SpeechServiceError } from './ports.ts';

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
  const directory = new StaticClinicDirectory(
    CLINIC,
    DEMO_PRACTITIONERS.map((p) => ({ practitionerId: p.practitionerId, displayName: p.displayName, clinicianType: 'DENTIST' as const })),
    DEMO_ROOMS.map((r, i) => ({ surgeryId: `surgery-${i + 1}`, name: r.name, roomId: r.roomId })),
    [{ email: 'pm@aura.test', displayName: 'Practice Manager', roles: ['CLINIC_ADMIN'], clinicianId: null, active: true }],
  );
  const cipher = AesGcmContentCipher.generate();
  return {
    clock,
    newId: () => `session-${++ids}`,
    clinic: { clinicId: CLINIC, name: 'Aura Dental Clinic', timeZone: 'Europe/London', dentallySiteId: null, settings: { earlyStartMinutes: 10, overrunMinutes: 30 } },
    dentally: mock,
    sessions: opts.repo ?? sessions,
    audit: auditSink,
    directory,
    admin: directory,
    content: new InMemoryScribeContentStore(),
    cipher: () => cipher,
    speech: new DemoSpeechTokenIssuer(clock),
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

  it('leaves at most one open session when two screens confirm at the same moment', async () => {
    const d = deps();
    const results = await Promise.allSettled([
      confirmPatient(nurse, d, confirmInput),
      confirmPatient(otherNurse, d, { ...confirmInput, surgeryId: 'surgery-2' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(['ACTIVE_SESSION_EXISTS', 'DUPLICATE_PATIENT_SESSION']).toContain((r.reason as AppError).code);
    }
    expect(sessions.all().filter((s) => !isTerminal(s.status))).toHaveLength(fulfilled.length);
  });

  it('never leaves two sessions when the screen that confirmed first is the slower one to save', async () => {
    let releaseFirst!: () => void;
    const firstMaySave = new Promise<void>((resolve) => (releaseFirst = resolve));
    let creates = 0;
    const slowFirst: SessionRepository = {
      create: async (session) => {
        creates += 1;
        if (creates === 1) await firstMaySave;
        return sessions.create(session);
      },
      get: (c, id) => sessions.get(c, id),
      update: (session, v) => sessions.update(session, v),
      findActive: (c, f) => sessions.findActive(c, f),
      findByAppointments: (c, a) => sessions.findByAppointments(c, a),
    };
    const d = deps('normal', { repo: slowFirst });
    const first = confirmPatient(nurse, d, confirmInput);
    while (creates === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    // The second screen confirms, saves and is told it succeeded while the first is still saving.
    const second = await confirmPatient(otherNurse, d, { ...confirmInput, surgeryId: 'surgery-2' });
    releaseFirst();
    await expectAppError(first, 'ACTIVE_SESSION_EXISTS');
    expect(sessions.all().filter((s) => !isTerminal(s.status)).map((s) => s.sessionId)).toEqual([second.session.sessionId]);
    expect(auditSink.events.find((e) => e.details.reasonCode === 'CONCURRENT_CONFIRMATION')?.sessionId).not.toBe(second.session.sessionId);
  });

  it('withdraws a session whose save reported a failure but went through', async () => {
    const savedThenFailed: SessionRepository = {
      create: async (session) => {
        await sessions.create(session);
        throw new Error('timed out');
      },
      get: (c, id) => sessions.get(c, id),
      update: (session, v) => sessions.update(session, v),
      findActive: (c, f) => sessions.findActive(c, f),
      findByAppointments: (c, a) => sessions.findByAppointments(c, a),
    };
    await expect(confirmPatient(nurse, deps('normal', { repo: savedThenFailed }), confirmInput)).rejects.toThrow('timed out');
    expect(sessions.all().map((s) => s.status)).toEqual(['CANCELLED']);
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'SESSION_CANCELLED', details: { reasonCode: 'CREATE_UNCONFIRMED' } });
    await expect(confirmPatient(nurse, deps(), confirmInput)).resolves.toBeTruthy();
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
    // Every session belongs to a surgery.
    await expectAppError(confirmPatient(nurse, deps(), { ...confirmInput, surgeryId: null }), 'VALIDATION');
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

  it('closes a session left unused an hour after its appointment ended, and refuses an answer on it', async () => {
    let t = NOW;
    const d = deps('normal', { clock: () => t });
    const { session } = await confirmPatient(nurse, d, confirmInput); // 10:25–11:10, confirmed at 10:40
    t = Date.parse('2026-10-20T11:25:00+01:00') + ABANDONED_AFTER_MS + 60_000;
    await expectAppError(
      recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: 1, surgeryId: 'surgery-1' }),
      'SESSION_EXPIRED',
    );
    expect((await sessions.get(CLINIC, session.sessionId))?.status).toBe('CANCELLED');
    expect((await getActiveSession(nurse, d, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' })).session).toBeNull();
  });

  it('does not close a late-started patient\'s session before their appointment could have ended', async () => {
    let t = Date.parse('2026-10-20T12:10:00+01:00'); // taken in long after the 10:25 booking
    const d = deps('normal', { clock: () => t });
    const { session } = await confirmPatient(nurse, d, { ...confirmInput, predictedAppointmentId: null, method: 'CHOSE_FROM_DIARY' });
    t = Date.parse('2026-10-20T13:30:00+01:00'); // 45-minute booking from 12:10 ends 12:55; still inside the hour after
    expect((await getActiveSession(nurse, d, { surgeryId: 'surgery-1', practitionerId: 'DEMO-PR1' })).session?.sessionId).toBe(session.sessionId);
    const r = await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: 1, surgeryId: 'surgery-1' });
    expect(r.session.status).toBe('READY');
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

describe('clinic setup', () => {
  it('is for the practice manager only', async () => {
    await expectAppError(getClinicSetup(nurse, deps()), 'FORBIDDEN');
    const setup = await getClinicSetup(manager, deps());
    expect(setup.dentally?.practitioners.map((p) => p.practitionerId)).toEqual(['DEMO-PR1', 'DEMO-PR2', 'DEMO-PR3']);
    expect(setup.clinicians).toHaveLength(3);
  });

  it('only configures clinicians Dentally knows, takes their names from Dentally, and can switch one off', async () => {
    const d = deps();
    await expectAppError(saveClinicians(manager, d, { clinicians: [{ practitionerId: 'MADE-UP', clinicianType: 'DENTIST', active: true }] }), 'VALIDATION');
    const r = await saveClinicians(manager, d, { clinicians: [{ practitionerId: 'DEMO-PR3', clinicianType: 'HYGIENIST', active: false }] });
    expect(r.clinicians.find((c) => c.practitionerId === 'DEMO-PR3')).toMatchObject({ displayName: 'Emma Reid', clinicianType: 'HYGIENIST', active: false });
    expect((await d.directory.listClinicians(CLINIC)).map((c) => c.practitionerId)).not.toContain('DEMO-PR3');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'CONFIG_CHANGED', details: { entity: 'CLINICIAN', change: 'SAVED', count: 1 } });
  });

  it('only configures surgeries for rooms Dentally knows', async () => {
    const d = deps();
    await expectAppError(saveSurgeries(manager, d, { surgeries: [{ roomId: 'NO-ROOM', active: true }] }), 'VALIDATION');
    // Surgeries can be named here when Dentally lists no rooms; names are unique.
    const named = await saveSurgeries(manager, d, { surgeries: [{ surgeryId: null, name: 'Surgery 5', active: true }] });
    const five = named.surgeries.find((x) => x.name === 'Surgery 5')!;
    expect(five).toMatchObject({ roomId: null, active: true });
    await expectAppError(saveSurgeries(manager, d, { surgeries: [{ surgeryId: null, name: 'surgery 5', active: true }] }), 'VALIDATION');
    const off = await saveSurgeries(manager, d, { surgeries: [{ surgeryId: five.surgeryId, name: 'Surgery 5', active: false }] });
    expect(off.surgeries.find((x) => x.surgeryId === five.surgeryId)!.active).toBe(false);
    await expectAppError(saveSurgeries(manager, d, { surgeries: [{ surgeryId: 'NOPE', name: 'X', active: true }] }), 'VALIDATION');
    const r = await saveSurgeries(manager, d, { surgeries: [{ roomId: 'DEMO-R2', active: false }] });
    expect(r.surgeries.find((s) => s.roomId === 'DEMO-R2')?.active).toBe(false);
  });

  it('adds staff with grantable roles only, and never removes the last practice manager', async () => {
    const d = deps();
    const added = await saveStaffProfile(manager, d, {
      email: ' New.Nurse@Aura.test ', displayName: 'New Nurse', roles: ['NURSE'], clinicianId: null, active: true,
    });
    expect(added.staff.find((x) => x.email === 'new.nurse@aura.test')).toMatchObject({ roles: ['NURSE'], active: true });
    await expectAppError(saveStaffProfile(manager, d, { email: 'x@aura.test', displayName: 'X', roles: ['SUPER_ADMIN'], active: true }), 'VALIDATION');
    await expectAppError(saveStaffProfile(manager, d, { email: 'x@aura.test', displayName: 'X', roles: ['DENTIST'], clinicianId: 'NOT-SET-UP', active: true }), 'VALIDATION');
    await expectAppError(saveStaffProfile(manager, d, { email: 'pm@aura.test', displayName: 'Practice Manager', roles: ['NURSE'], active: true }), 'VALIDATION');
    await expectAppError(saveStaffProfile(nurse, d, { email: 'y@aura.test', displayName: 'Y', roles: ['NURSE'], active: true }), 'FORBIDDEN');
  });
});

describe('scribe capture', () => {
  const at = { surgeryId: 'surgery-1' };
  const line = (n: number, text = `Line ${n} about the lower left six.`) => ({
    kind: 'SPEECH' as const,
    segmentId: `segment-${String(n).padStart(4, '0')}`,
    seq: n,
    startMs: n * 1000,
    endMs: n * 1000 + 800,
    speaker: 'S1',
    text,
  });

  async function readySession(d: HandlerDeps) {
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const r = await recordConsent(nurse, d, { sessionId: session.sessionId, given: true, expectedVersion: session.version, ...at });
    return r.session;
  }

  async function recordingSession(d: HandlerDeps) {
    const s = await readySession(d);
    return (await changeRecording(nurse, d, { sessionId: s.sessionId, action: 'START', expectedVersion: s.version, ...at })).session;
  }

  it('starts, pauses, resumes and stops recording, auditing each change', async () => {
    const d = deps();
    let s = await readySession(d);
    for (const [action, status] of [['START', 'RECORDING'], ['PAUSE', 'PAUSED'], ['RESUME', 'RECORDING'], ['STOP', 'STOPPED']] as const) {
      const r = await changeRecording(nurse, d, { sessionId: s.sessionId, action, expectedVersion: s.version, ...at });
      expect(r.session.status).toBe(status);
      expect(r.warning).toBeNull();
      s = r.session;
    }
    expect(auditSink.events.filter((e) => e.action === 'SESSION_STATUS_CHANGED').map((e) => e.details.reasonCode)).toEqual([
      'USER_START',
      'USER_PAUSE',
      'USER_RESUME',
      'USER_STOP',
    ]);
  });

  it('cannot start before the patient agrees', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    const err = await expectAppError(changeRecording(nurse, d, { sessionId: session.sessionId, action: 'START', expectedVersion: session.version, ...at }), 'SESSION_TRANSITION_REFUSED');
    expect(err.details.reason).toBe('CONSENT_REQUIRED');
  });

  it('only gives a speech token while recording, and audits it', async () => {
    const d = deps();
    const ready = await readySession(d);
    await expectAppError(getSpeechToken(nurse, d, { sessionId: ready.sessionId, ...at }), 'SESSION_TRANSITION_REFUSED');
    const rec = (await changeRecording(nurse, d, { sessionId: ready.sessionId, action: 'START', expectedVersion: ready.version, ...at })).session;
    const token = await getSpeechToken(nurse, d, { sessionId: rec.sessionId, ...at });
    expect(token.provider).toBe('DEMO');
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'SPEECH_TOKEN_ISSUED', details: { provider: 'DEMO' } });
  });

  it('refuses tokens and content from another surgery or someone outside the session', async () => {
    const d = deps();
    const s = await recordingSession(d);
    await expectAppError(getSpeechToken(nurse, d, { sessionId: s.sessionId, surgeryId: 'surgery-2' }), 'SURGERY_MISMATCH');
    await expectAppError(saveTranscript(otherNurse, d, { sessionId: s.sessionId, segments: [line(1)], ...at }), 'FORBIDDEN');
    await expectAppError(getScribeContent(otherNurse, d, { sessionId: s.sessionId, ...at }), 'FORBIDDEN');
  });

  it('reports speech-to-text problems clearly', async () => {
    const failing = (kind: 'NOT_CONFIGURED' | 'AUTH' | 'UNAVAILABLE'): SpeechTokenIssuer => ({
      provider: 'SPEECHMATICS',
      issue: async () => {
        throw new SpeechServiceError(kind);
      },
    });
    for (const [kind, code] of [['NOT_CONFIGURED', 'SPEECH_NOT_CONFIGURED'], ['AUTH', 'SPEECH_NOT_CONFIGURED'], ['UNAVAILABLE', 'SPEECH_UNAVAILABLE']] as const) {
      const d = { ...deps('normal', { repo: new InMemorySessionRepository() }), speech: failing(kind) };
      const s = await recordingSession(d);
      await expectAppError(getSpeechToken(nurse, d, { sessionId: s.sessionId, ...at }), code);
    }
  });

  it('stores transcript encrypted, once per segment ID, and returns it in order', async () => {
    const d = deps();
    const s = await recordingSession(d);
    expect((await saveTranscript(nurse, d, { sessionId: s.sessionId, segments: [line(2), line(1)], ...at })).saved).toBe(2);
    // A retry after a timeout stores nothing twice.
    expect((await saveTranscript(nurse, d, { sessionId: s.sessionId, segments: [line(1), line(3)], ...at })).saved).toBe(1);
    const stored = await d.content.listSegments(CLINIC, s.sessionId);
    expect(stored).toHaveLength(3);
    for (const r of stored) expect(r.cipherText).not.toContain('lower left');
    const content = await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    expect(content.segments.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(content.segments[0]!.text).toBe('Line 1 about the lower left six.');
  });

  it('accepts the last transcript after stopping, but none before recording or after a decline', async () => {
    const d = deps();
    const ready = await readySession(d);
    await expectAppError(saveTranscript(nurse, d, { sessionId: ready.sessionId, segments: [line(1)], ...at }), 'SESSION_TRANSITION_REFUSED');
    const rec = (await changeRecording(nurse, d, { sessionId: ready.sessionId, action: 'START', expectedVersion: ready.version, ...at })).session;
    const stopped = (await changeRecording(nurse, d, { sessionId: rec.sessionId, action: 'STOP', expectedVersion: rec.version, ...at })).session;
    expect((await saveTranscript(nurse, d, { sessionId: stopped.sessionId, segments: [line(1)], ...at })).saved).toBe(1);
    await recordConsent(nurse, d, { sessionId: stopped.sessionId, given: false, expectedVersion: stopped.version, ...at });
    await expectAppError(saveTranscript(nurse, d, { sessionId: stopped.sessionId, segments: [line(2)], ...at }), 'SESSION_TRANSITION_REFUSED');
  });

  it('deletes everything captured when the patient withdraws, and audits the count without text', async () => {
    const d = deps();
    const s = await recordingSession(d);
    await saveTranscript(nurse, d, { sessionId: s.sessionId, segments: [line(1), line(2)], ...at });
    await saveNurseNote(nurse, d, { sessionId: s.sessionId, text: 'Shade A2', expectedRevision: 0, ...at });
    await recordConsent(nurse, d, { sessionId: s.sessionId, given: false, expectedVersion: s.version, ...at });
    expect(await d.content.listSegments(CLINIC, s.sessionId)).toEqual([]);
    expect(await d.content.getNurseNote(CLINIC, s.sessionId)).toBeNull();
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'SCRIBE_CONTENT_DELETED', details: { reasonCode: 'CONSENT_WITHDRAWN', count: 3 } });
    expect(JSON.stringify(auditSink.events)).not.toMatch(/lower left|Shade/);
  });

  it('says so when withdrawn content could not be deleted', async () => {
    const base = deps();
    const d = { ...base, content: { ...base.content, deleteSession: async () => Promise.reject(new Error('down')) } } as HandlerDeps;
    d.content.listSegments = base.content.listSegments.bind(base.content);
    const s = await recordingSession(d);
    await expectAppError(recordConsent(nurse, d, { sessionId: s.sessionId, given: false, expectedVersion: s.version, ...at }), 'INTERNAL');
    // The session is still closed: nothing more can be recorded.
    expect((await sessions.get(CLINIC, s.sessionId))!.status).toBe('CONSENT_DECLINED');
  });

  it('deletes nurse notes typed before recording when the session is cancelled', async () => {
    const d = deps();
    const s = await readySession(d);
    await saveNurseNote(nurse, d, { sessionId: s.sessionId, text: 'Patient anxious', expectedRevision: 0, ...at });
    await cancelSession(nurse, d, { sessionId: s.sessionId, expectedVersion: s.version });
    expect(await d.content.getNurseNote(CLINIC, s.sessionId)).toBeNull();
  });

  it('saves nurse notes by revision, refusing a stale save', async () => {
    const d = deps();
    const s = await recordingSession(d);
    const first = await saveNurseNote(nurse, d, { sessionId: s.sessionId, text: 'Shade A2', expectedRevision: 0, ...at });
    expect(first.nurseNote.revision).toBe(1);
    await saveNurseNote(nurse, d, { sessionId: s.sessionId, text: 'Shade A2, batch 1234', expectedRevision: 1, ...at });
    await expectAppError(saveNurseNote(nurse, d, { sessionId: s.sessionId, text: 'Overwrite', expectedRevision: 1, ...at }), 'VERSION_CONFLICT');
    const content = await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    expect(content.nurseNote).toMatchObject({ text: 'Shade A2, batch 1234', revision: 2, updatedBy: nurse.email });
  });

  it('refuses nurse notes before the patient agrees', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await expectAppError(saveNurseNote(nurse, d, { sessionId: session.sessionId, text: 'x', expectedRevision: 0, ...at }), 'SESSION_TRANSITION_REFUSED');
  });

  it('audits viewing saved content once per window, with counts only', async () => {
    let t = NOW;
    const d = deps('normal', { clock: () => t });
    const s = await recordingSession(d);
    await saveTranscript(nurse, d, { sessionId: s.sessionId, segments: [line(1)], ...at });
    await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    const views = () => auditSink.events.filter((e) => e.action === 'SCRIBE_CONTENT_VIEWED');
    expect(views()).toHaveLength(1);
    expect(views()[0]!.details).toEqual({ purpose: 'RESTORE', segmentCount: 1, hasNurseNote: false });
    t += 16 * 60_000;
    await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    expect(views()).toHaveLength(2);
  });

  it('deletes content past its time when recording starts, and warns if that fails', async () => {
    const d = deps();
    await d.content.addSegments(CLINIC, 'old-session', [
      { kind: 'SPEECH', segmentId: 'old-segment-1', seq: 1, startMs: 0, endMs: 1, speaker: null, cipherText: 'v1.x.y', capturedBy: 'n', savedAtMs: NOW - 3 * DAY_MS, deleteAfterMs: NOW - DAY_MS },
    ]);
    const s = await readySession(d);
    const r = await changeRecording(nurse, d, { sessionId: s.sessionId, action: 'START', expectedVersion: s.version, ...at });
    expect(r.warning).toBeNull();
    expect(await d.content.listSegments(CLINIC, 'old-session')).toEqual([]);
    expect(auditSink.events.some((e) => e.action === 'SCRIBE_CONTENT_DELETED' && e.details.reasonCode === 'RETENTION_EXPIRED')).toBe(true);

    const broken = deps('normal', { repo: new InMemorySessionRepository() });
    const failing = { ...broken, content: Object.assign(Object.create(Object.getPrototypeOf(broken.content)), broken.content, { purgeExpired: async () => Promise.reject(new Error('down')) }) } as HandlerDeps;
    const s2 = await readySession(failing);
    const r2 = await changeRecording(nurse, failing, { sessionId: s2.sessionId, action: 'START', expectedVersion: s2.version, ...at });
    expect(r2.session.status).toBe('RECORDING');
    expect(r2.warning).toBe('RETENTION_CLEANUP_FAILED');
  });

  it('will not start recording a session from an earlier day', async () => {
    let t = NOW;
    const d = deps('normal', { clock: () => t });
    const s = await readySession(d);
    t = NOW + DAY_MS;
    const err = await changeRecording(nurse, d, { sessionId: s.sessionId, action: 'START', expectedVersion: s.version, ...at }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(['NOT_TODAY', 'SESSION_EXPIRED']).toContain((err as AppError).code);
  });

  it('deletes transcript that lands after a withdrawal raced the save', async () => {
    const d = deps();
    const s = await recordingSession(d);
    const realAdd = d.content.addSegments.bind(d.content);
    let raced = false;
    d.content.addSegments = async (clinicId, sessionId, list) => {
      if (!raced) {
        // The withdrawal is recorded after the save checked permission but before its rows are written.
        raced = true;
        const current = (await sessions.get(CLINIC, s.sessionId))!;
        await recordConsent(nurse, d, { sessionId: s.sessionId, given: false, expectedVersion: current.version, ...at });
      }
      return realAdd(clinicId, sessionId, list);
    };
    await expectAppError(saveTranscript(nurse, d, { sessionId: s.sessionId, segments: [line(1)], ...at }), 'SESSION_TRANSITION_REFUSED');
    expect(await d.content.listSegments(CLINIC, s.sessionId)).toEqual([]);
  });

  it('keeps gap markers with the transcript', async () => {
    const d = deps();
    const s = await recordingSession(d);
    await saveTranscript(nurse, d, {
      sessionId: s.sessionId,
      segments: [line(1), { ...line(2, 'Speech may be missing here: the microphone stopped.'), kind: 'GAP', speaker: null }],
      ...at,
    });
    const c = await getScribeContent(nurse, d, { sessionId: s.sessionId, ...at });
    expect(c.segments.map((x) => x.kind)).toEqual(['SPEECH', 'GAP']);
  });

  it('deletes expired content whenever a diary is read, and says when it could not', async () => {
    const d = deps();
    await d.content.addSegments(CLINIC, 'old-session', [
      { kind: 'SPEECH', segmentId: 'old-segment-2', seq: 1, startMs: 0, endMs: 1, speaker: null, cipherText: 'v1.x.y', capturedBy: 'n', savedAtMs: NOW - 3 * DAY_MS, deleteAfterMs: NOW - DAY_MS },
    ]);
    const r = await getDiary(nurse, d, { practitionerId: 'DEMO-PR1' });
    expect(r.retentionCleanupFailed).toBe(false);
    expect(await d.content.listSegments(CLINIC, 'old-session')).toEqual([]);
    const failing = { ...d, content: Object.assign(Object.create(Object.getPrototypeOf(d.content)), d.content, { purgeExpired: async () => Promise.reject(new Error('down')) }) } as HandlerDeps;
    expect((await getDiary(nurse, failing, { practitionerId: 'DEMO-PR1' })).retentionCleanupFailed).toBe(true);
  });
});

describe('getDentallyCheck', () => {
  it('counts today\'s Dentally diary by practitioner and room, for the practice manager only, with no patient data', async () => {
    const d = deps();
    const r = await getDentallyCheck(manager, d);
    expect(r.total).toBeGreaterThan(0);
    expect(Object.values(r.byPractitioner).reduce((a, b) => a + b, 0)).toBe(r.total);
    expect(JSON.stringify(r)).not.toMatch(/Oliver|Bennett|DEMO-P1/);
    await expectAppError(getDentallyCheck(nurse, d), 'FORBIDDEN');
  });
});

describe('note templates and copied notes', () => {
  it('lists the starters for everyone, and lets the practice manager add, edit and switch off the clinic\'s own', async () => {
    const d = deps();
    const first = await listNoteTemplates(dentist, d);
    expect(first.templates.every((t) => t.starter)).toBe(true);
    await expectAppError(saveNoteTemplate(dentist, d, { title: 'Root canal', body: 'RCT [Tooth]' }), 'FORBIDDEN');
    const created = await saveNoteTemplate(manager, d, { title: 'Root canal', body: 'RCT [Tooth]\nWL: [Working length]' });
    expect(created.templates[0]).toMatchObject({ title: 'Root canal', starter: false, updatedBy: manager.email });
    await saveNoteTemplate(manager, d, { templateId: created.templateId, title: 'Root canal', body: 'RCT [Tooth]', active: false });
    expect((await listNoteTemplates(dentist, d)).templates.some((t) => t.templateId === created.templateId)).toBe(false);
    expect((await listNoteTemplates(dentist, d, { includeInactive: true })).templates.find((t) => t.templateId === created.templateId)!.active).toBe(false);
    expect(auditSink.events.filter((e) => e.action === 'CONFIG_CHANGED').map((e) => e.details)).toEqual([
      { entity: 'NOTE_TEMPLATE', change: 'CREATED', count: 1 },
      { entity: 'NOTE_TEMPLATE', change: 'UPDATED', count: 1 },
    ]);
  });

  it('refuses changes to starters, duplicate names, bad text and roles without access', async () => {
    const d = deps();
    await expectAppError(saveNoteTemplate(manager, d, { templateId: 'starter-examination', title: 'Mine', body: 'x' }), 'VALIDATION');
    await saveNoteTemplate(manager, d, { title: 'Recall', body: 'x' });
    await expectAppError(saveNoteTemplate(manager, d, { title: 'recall', body: 'y' }), 'VALIDATION');
    await expectAppError(saveNoteTemplate(manager, d, { title: 'Empty', body: '  ' }), 'VALIDATION');
    await expectAppError(saveNoteTemplate(manager, d, { templateId: 'NOPE', title: 'Gone', body: 'x' }), 'NOT_FOUND');
    await expectAppError(saveNoteTemplate(auditor, d, { title: 'Nope', body: 'x' }), 'FORBIDDEN');
  });

  it('audits a copied note against the session patient, never with its text', async () => {
    const d = deps();
    const { session } = await confirmPatient(nurse, d, confirmInput);
    await recordNoteCopied(nurse, d, { sessionId: session.sessionId, templateId: 'starter-composite', unfilledCount: 1 });
    expect(auditSink.events.at(-1)).toMatchObject({
      action: 'NOTE_COPIED',
      sessionId: session.sessionId,
      dentallyPatientId: 'DEMO-P1001',
      details: { templateId: 'starter-composite', unfilledCount: 1, source: 'SESSION' },
    });
    await recordNoteCopied(dentist, d, { sessionId: null, templateId: null, unfilledCount: 0 });
    expect(auditSink.events.at(-1)).toMatchObject({ action: 'NOTE_COPIED', dentallyPatientId: null, details: { source: 'STANDALONE' } });
    await expectAppError(recordNoteCopied(otherNurse, d, { sessionId: session.sessionId, templateId: null, unfilledCount: 0 }), 'FORBIDDEN');
    // Still allowed after a decline (notes by hand need no permission for the scribe); refused once cancelled.
    const declined = await recordConsent(nurse, d, { sessionId: session.sessionId, given: false, expectedVersion: session.version, surgeryId: 'surgery-1' });
    await recordNoteCopied(nurse, d, { sessionId: declined.session.sessionId, templateId: null, unfilledCount: 0 });
    const other = (await confirmPatient(nurse, d, amara)).session;
    await cancelSession(nurse, d, { sessionId: other.sessionId, expectedVersion: other.version });
    await expectAppError(recordNoteCopied(nurse, d, { sessionId: other.sessionId, templateId: null, unfilledCount: 0 }), 'SESSION_TRANSITION_REFUSED');
  });
});
