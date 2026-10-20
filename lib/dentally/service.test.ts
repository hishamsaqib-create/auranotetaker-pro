import { describe, expect, it } from 'vitest';
import { predictLikelyPatient } from '../core/prediction.ts';
import { DentallyClient } from './client.ts';
import { MockDentallyService } from './mock.ts';
import { normaliseState, parseAppointment, parsePatient, parsePractitioner } from './parse.ts';
import { createLiveDentallyService } from './service.ts';

const rawAppointment = {
  id: 9001,
  start_time: '2026-10-20T10:30:00.000+01:00',
  finish_time: '2026-10-20T11:15:00.000+01:00',
  state: 'In surgery',
  practitioner_id: 42,
  patient_id: 777,
  patient_name: 'Oliver Bennett',
  room_id: 3,
  reason: 'Halo Veneer Fit',
  notes: 'diary note that must never be used',
  in_surgery_at: '2026-10-20T10:31:00.000+01:00',
};

describe('parseAppointment', () => {
  it('normalises a Dentally appointment and ignores fields the scribe does not need', () => {
    const r = parseAppointment(rawAppointment);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      appointmentId: '9001',
      patientId: '777',
      practitionerId: '42',
      roomId: '3',
      state: 'In surgery',
      reason: 'Halo Veneer Fit',
      startMs: Date.parse('2026-10-20T09:30:00Z'),
    });
    expect(JSON.stringify(r.value)).not.toContain('diary note');
  });

  it('rejects appointments with missing or zone-less times instead of guessing', () => {
    expect(parseAppointment({ ...rawAppointment, start_time: '2026-10-20T10:30:00' })).toEqual({ ok: false, reason: 'BAD_TIMES' });
    expect(parseAppointment({ ...rawAppointment, finish_time: rawAppointment.start_time })).toEqual({ ok: false, reason: 'BAD_TIMES' });
    expect(parseAppointment({ ...rawAppointment, id: undefined })).toEqual({ ok: false, reason: 'MISSING_ID' });
    expect(parseAppointment({ ...rawAppointment, practitioner_id: null })).toEqual({ ok: false, reason: 'MISSING_PRACTITIONER' });
    expect(parseAppointment('nonsense')).toEqual({ ok: false, reason: 'NOT_AN_OBJECT' });
  });

  it('keeps patient-less diary entries but never attaches a name to them', () => {
    const r = parseAppointment({ ...rawAppointment, patient_id: null, patient_name: 'Lab call' });
    expect(r.ok && r.value.patientId).toBeNull();
    expect(r.ok && r.value.patientName).toBeNull();
  });
});

describe('normaliseState', () => {
  it('accepts Dentally states in either spelling and marks anything else Unknown', () => {
    expect(normaliseState('In surgery').state).toBe('In surgery');
    expect(normaliseState('in_surgery').state).toBe('In surgery');
    expect(normaliseState('DID NOT ATTEND').state).toBe('Did not attend');
    expect(normaliseState('Ready for checkout')).toEqual({ state: 'Unknown', rawState: 'Ready for checkout' });
    expect(normaliseState(undefined)).toEqual({ state: 'Unknown', rawState: null });
  });
});

describe('parsePatient and parsePractitioner', () => {
  it('returns display name and a valid date of birth only', () => {
    const r = parsePatient({ id: 777, title: 'Mr', first_name: 'Oliver', last_name: 'Bennett', date_of_birth: '1986-03-12', email_address: 'x@y.z' });
    expect(r).toEqual({ ok: true, value: { patientId: '777', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' } });
    const bad = parsePatient({ id: 778, first_name: 'Ann', date_of_birth: '1986-02-30' });
    expect(bad.ok && bad.value.dateOfBirth).toBeNull();
  });

  it('keeps both practitioner and user IDs, because Aura\'s integrations have used either', () => {
    const r = parsePractitioner({ id: 42, active: true, user: { id: 9, title: 'Dr', first_name: 'Sarah', last_name: 'Lin' } });
    expect(r).toEqual({ ok: true, value: { practitionerId: '42', userId: '9', displayName: 'Dr Sarah Lin', active: true } });
  });
});

describe('live Dentally service', () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/appointments') {
      return new Response(JSON.stringify({ appointments: [rawAppointment, { id: 'broken' }], meta: { total_pages: 1 } }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const service = createLiveDentallyService(
    new DentallyClient({ baseUrl: 'https://api.sandbox.dentally.co', token: 't', userAgent: 'ua', fetchImpl, sleep: async () => {} }),
  );

  it('drops and counts records that fail validation', async () => {
    const r = await service.getTodaysAppointments({ date: '2026-10-20' });
    expect(r.appointments).toHaveLength(1);
    expect(r.rejectedCount).toBe(1);
  });

  it('answers clinical-record requests with an explicit "not supported", never a workaround', async () => {
    expect(service.capabilities()).toMatchObject({ readClinicalNotes: false, writeClinicalNotes: false, readClinicalHistory: false });
    await expect(service.createClinicalNote({ text: 'anything' })).resolves.toMatchObject({ supported: false, reason: 'NOT_AVAILABLE_IN_DENTALLY_API' });
    await expect(service.getPatientNotes('777')).resolves.toMatchObject({ supported: false });
    await expect(service.getPatientClinicalHistory('777')).resolves.toMatchObject({ supported: false });
  });
});

describe('mock Dentally service scenarios', () => {
  const now = Date.parse('2026-10-20T10:40:00+01:00');
  const predict = async (scenario: ConstructorParameters<typeof MockDentallyService>[0]['scenario']) => {
    const mock = new MockDentallyService({ clock: () => now, scenario });
    const { appointments } = await mock.getClinicianAppointments({ practitionerId: 'DEMO-PR1' });
    return predictLikelyPatient({ nowMs: now, practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', appointments });
  };

  it('normal: one patient in surgery now', async () => {
    const r = await predict('normal');
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.appointment.patientId).toBe('DEMO-P1001');
  });

  it('double-booked and overrun scenarios are ambiguous', async () => {
    expect((await predict('double-booked')).status).toBe('AMBIGUOUS');
    expect((await predict('overrun')).status).toBe('AMBIGUOUS');
  });

  it('between appointments: nothing current, next appointment offered', async () => {
    const r = await predict('between');
    expect(r.status).toBe('NONE');
    expect(r.nextAppointment?.appointmentId).toBe('DEMO-A04');
  });

  it('taken early: the next patient is suggested with HIGH confidence', async () => {
    const r = await predict('taken-early');
    expect(r.status).toBe('LIKELY');
    expect(r.likely?.confidence).toBe('HIGH');
  });

  it('offline: every call fails as Dentally being unavailable', async () => {
    const mock = new MockDentallyService({ clock: () => now, scenario: 'dentally-offline' });
    await expect(mock.getTodaysAppointments()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('uses only obviously fictional identifiers', async () => {
    const mock = new MockDentallyService({ clock: () => now });
    const { appointments } = await mock.getTodaysAppointments();
    for (const a of appointments) {
      expect(a.appointmentId.startsWith('DEMO-')).toBe(true);
      if (a.patientId) expect(a.patientId.startsWith('DEMO-')).toBe(true);
    }
  });
});
