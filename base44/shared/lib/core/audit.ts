// GENERATED from lib/core/audit.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Audit events.
//
// SAFETY: audit metadata must never contain patient names, dates of birth, transcript
// text, note text or staff free text. Each action has an allowlist of detail keys, and
// values must be short primitives. Anything else throws, so a developer mistake fails
// loudly in tests instead of quietly copying clinical text into the audit log.

export const AUDIT_DETAIL_KEYS = {
  DIARY_VIEWED: ['date', 'practitionerId', 'appointmentCount', 'rejectedCount'],
  PATIENT_VIEWED: ['purpose'],
  PATIENT_CONFIRMED: ['method', 'predictedAppointmentId', 'matchedPrediction', 'surgeryId', 'practitionerId'],
  CONSENT_RECORDED: ['given', 'statusBefore'],
  PATIENT_REASSIGNED: ['fromPatientId', 'toPatientId', 'fromAppointmentId', 'toAppointmentId', 'consentCarriedOver'],
  SESSION_CANCELLED: ['statusBefore'],
  SESSION_STATUS_CHANGED: ['from', 'to'],
  INTEGRATION_CHECKED: ['integration', 'result', 'latencyMs'],
  ACCESS_DENIED: ['operation', 'reasonCode'],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_DETAIL_KEYS;

export type AuditDetailValue = string | number | boolean | null;

export interface AuditEvent {
  clinicId: string;
  occurredAtMs: number;
  actorEmail: string;
  actorRoles: string[];
  action: AuditAction;
  sessionId: string | null;
  dentallyPatientId: string | null;
  dentallyAppointmentId: string | null;
  details: Record<string, AuditDetailValue>;
  client: { deviceId: string | null; appVersion: string | null };
}

export class AuditDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditDetailsError';
  }
}

const MAX_STRING_LENGTH = 80;

export interface BuildAuditEventInput {
  clinicId: string;
  occurredAtMs: number;
  actorEmail: string;
  actorRoles: readonly string[];
  action: AuditAction;
  sessionId?: string | null;
  dentallyPatientId?: string | null;
  dentallyAppointmentId?: string | null;
  details?: Record<string, unknown>;
  client?: { deviceId?: string | null; appVersion?: string | null };
}

export function buildAuditEvent(input: BuildAuditEventInput): AuditEvent {
  const allowed: readonly string[] = AUDIT_DETAIL_KEYS[input.action];
  if (!allowed) throw new AuditDetailsError(`Unknown audit action`);
  const details: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(input.details ?? {})) {
    if (!allowed.includes(key)) {
      // Report the key only, never the value: the value may be the very data we must not log.
      throw new AuditDetailsError(`Detail key "${key}" is not allowed for ${input.action}`);
    }
    if (value === undefined) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      details[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > MAX_STRING_LENGTH) throw new AuditDetailsError(`Detail "${key}" is too long for audit metadata`);
      details[key] = value;
    } else {
      throw new AuditDetailsError(`Detail "${key}" must be a short primitive value`);
    }
  }
  return {
    clinicId: input.clinicId,
    occurredAtMs: input.occurredAtMs,
    actorEmail: input.actorEmail,
    actorRoles: [...input.actorRoles],
    action: input.action,
    sessionId: input.sessionId ?? null,
    dentallyPatientId: input.dentallyPatientId ?? null,
    dentallyAppointmentId: input.dentallyAppointmentId ?? null,
    details,
    client: { deviceId: input.client?.deviceId ?? null, appVersion: input.client?.appVersion ?? null },
  };
}
