import { describe, expect, it } from 'vitest';
import { AuditDetailsError, buildAuditEvent } from './audit.ts';

const base = { clinicId: 'clinic-aura', occurredAtMs: 0, actorEmail: 'dr@aura.test', actorRoles: ['DENTIST'] };

describe('buildAuditEvent', () => {
  it('builds an event with allowlisted details', () => {
    const e = buildAuditEvent({
      ...base,
      action: 'PATIENT_CONFIRMED',
      sessionId: 's-1',
      dentallyPatientId: 'p-1',
      dentallyAppointmentId: 'a-1',
      details: { method: 'CONFIRMED_SUGGESTION', predictedAppointmentId: 'a-1', matchedPrediction: true, practitionerId: 'pr-1' },
    });
    expect(e.details).toEqual({ method: 'CONFIRMED_SUGGESTION', predictedAppointmentId: 'a-1', matchedPrediction: true, practitionerId: 'pr-1' });
    expect(e.client).toEqual({ deviceId: null, appVersion: null });
  });

  it('rejects detail keys that are not allowlisted for the action, without echoing the value', () => {
    try {
      buildAuditEvent({ ...base, action: 'PATIENT_VIEWED', details: { patientName: 'Jane Example' } });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditDetailsError);
      expect((err as Error).message).toContain('patientName');
      expect((err as Error).message).not.toContain('Jane Example');
    }
  });

  it('rejects allowlisted keys carrying free text, names or dates in the wrong place', () => {
    const attempts: Array<[Parameters<typeof buildAuditEvent>[0]['action'], Record<string, unknown>]> = [
      ['SESSION_CANCELLED', { reasonCode: 'Oliver Bennett' }],
      ['SESSION_CANCELLED', { statusBefore: 'Patient was upset' }],
      ['PATIENT_VIEWED', { purpose: 'Checking Jane' }],
      ['DIARY_VIEWED', { date: '12/03/1986' }],
      ['SESSION_STATUS_CHANGED', { from: { text: 'note' } }],
      ['ACCESS_DENIED', { operation: 'x'.repeat(200) }],
    ];
    for (const [action, details] of attempts) {
      expect(() => buildAuditEvent({ ...base, action, details }), JSON.stringify(details)).toThrow(AuditDetailsError);
    }
  });

  it('requires identifiers in the identifier fields', () => {
    expect(() => buildAuditEvent({ ...base, action: 'PATIENT_VIEWED', dentallyPatientId: 'Jane Example', details: { purpose: 'IDENTITY_CHECK' } })).toThrow(
      AuditDetailsError,
    );
  });
});
