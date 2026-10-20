// GENERATED from lib/core/audit.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Audit events.
//
// SAFETY: audit metadata must never contain patient names, dates of birth, transcript
// text, note text or staff free text. Each action has an allowlist of detail keys, and
// each key has a value rule (an identifier, a code from a fixed list, a number, a boolean
// or a calendar date). Anything else throws, so a developer mistake fails loudly in tests
// instead of quietly copying clinical text into the audit log.

const SESSION_STATUSES = [
  'PATIENT_CONFIRMED',
  'CONSENT_DECLINED',
  'READY',
  'RECORDING',
  'PAUSED',
  'STOPPED',
  'GENERATING',
  'IN_REVIEW',
  'APPROVED',
  'DISCARDED',
  'CANCELLED',
] as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Rule = (v: unknown) => boolean;
const isId: Rule = (v) => typeof v === 'string' && ID.test(v);
const isCode: Rule = (v) => typeof v === 'string' && CODE.test(v);
const isDate: Rule = (v) => typeof v === 'string' && DATE.test(v);
const isBool: Rule = (v) => typeof v === 'boolean';
const isCount: Rule = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const oneOf =
  (...values: readonly string[]): Rule =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const nullable =
  (rule: Rule): Rule =>
  (v) =>
    v === null || rule(v);

const status = oneOf(...SESSION_STATUSES);

export const AUDIT_DETAIL_RULES = {
  DIARY_VIEWED: { date: isDate, practitionerId: isId, appointmentCount: isCount, rejectedCount: isCount },
  PATIENT_VIEWED: { purpose: oneOf('IDENTITY_CHECK', 'SESSION_BANNER') },
  PATIENT_CONFIRMED: {
    method: oneOf('CONFIRMED_SUGGESTION', 'CHOSE_ALTERNATIVE', 'RESOLVED_AMBIGUITY', 'CHOSE_FROM_DIARY'),
    predictedAppointmentId: nullable(isId),
    matchedPrediction: isBool,
    serverPredictionStatus: oneOf('LIKELY', 'AMBIGUOUS', 'NONE', 'UNAVAILABLE'),
    serverPredictedAppointmentId: nullable(isId),
    acknowledgedPreviousDecline: isBool,
    surgeryId: nullable(isId),
    practitionerId: isId,
  },
  CONSENT_RECORDED: { given: isBool, statusBefore: status },
  PATIENT_REASSIGNED: {
    fromPatientId: isId,
    toPatientId: isId,
    fromAppointmentId: isId,
    toAppointmentId: isId,
    consentCarriedOver: isBool,
  },
  SESSION_CANCELLED: { statusBefore: status, reasonCode: isCode },
  SESSION_STATUS_CHANGED: { from: status, to: status, reasonCode: isCode },
  INTEGRATION_CHECKED: { integration: oneOf('DENTALLY', 'STT', 'LLM', 'GOOGLE_DRIVE'), result: isCode, latencyMs: isCount },
  ACCESS_DENIED: { operation: isId, reasonCode: isCode },
} as const satisfies Record<string, Record<string, Rule>>;

export type AuditAction = keyof typeof AUDIT_DETAIL_RULES;

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
  /** Groups repeat events (e.g. diary views) so they can be recorded once per window. No patient data. */
  dedupeKey: string | null;
}

export class AuditDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditDetailsError';
  }
}

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
  dedupeKey?: string | null;
}

export function buildAuditEvent(input: BuildAuditEventInput): AuditEvent {
  const rules = AUDIT_DETAIL_RULES[input.action] as Record<string, Rule> | undefined;
  if (!rules) throw new AuditDetailsError('Unknown audit action');
  const details: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(input.details ?? {})) {
    const rule = rules[key];
    // Report the key only, never the value: the value may be the very data we must not log.
    if (!rule) throw new AuditDetailsError(`Detail key "${key}" is not allowed for ${input.action}`);
    if (value === undefined) continue;
    if (!rule(value)) throw new AuditDetailsError(`Detail "${key}" has a value that is not allowed in audit metadata`);
    details[key] = value as AuditDetailValue;
  }
  for (const [field, value] of [
    ['sessionId', input.sessionId],
    ['dentallyPatientId', input.dentallyPatientId],
    ['dentallyAppointmentId', input.dentallyAppointmentId],
  ] as const) {
    if (value != null && !ID.test(value)) throw new AuditDetailsError(`${field} must be an identifier`);
  }
  if (input.dedupeKey != null && !/^[A-Za-z0-9_:.-]{1,120}$/.test(input.dedupeKey)) {
    throw new AuditDetailsError('dedupeKey must be built from identifiers');
  }
  // The device ID comes from a request header and the version from the build: both must be plain tokens.
  if (input.client?.deviceId != null && !ID.test(input.client.deviceId)) throw new AuditDetailsError('client.deviceId must be an identifier');
  if (input.client?.appVersion != null && !/^[0-9A-Za-z.+-]{1,32}$/.test(input.client.appVersion)) {
    throw new AuditDetailsError('client.appVersion must be a version string');
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
    dedupeKey: input.dedupeKey ?? null,
  };
}
