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
      details: { method: 'CONFIRMED_SUGGESTION', predictedAppointmentId: 'a-1', matchedPrediction: true },
    });
    expect(e.details).toEqual({ method: 'CONFIRMED_SUGGESTION', predictedAppointmentId: 'a-1', matchedPrediction: true });
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

  it('rejects long strings and non-primitive values (no clinical text in audit metadata)', () => {
    expect(() =>
      buildAuditEvent({ ...base, action: 'SESSION_CANCELLED', details: { statusBefore: 'x'.repeat(200) } }),
    ).toThrow(AuditDetailsError);
    expect(() =>
      buildAuditEvent({ ...base, action: 'SESSION_STATUS_CHANGED', details: { from: { text: 'note' } } }),
    ).toThrow(AuditDetailsError);
  });
});
