// GENERATED from lib/server/errors.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Errors returned to the client. Messages are written for staff and never include patient data.

export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'PATIENT_MISMATCH'
  | 'NOT_TODAY'
  | 'APPOINTMENT_CLOSED'
  | 'PRACTITIONER_MISMATCH'
  | 'ACTIVE_SESSION_EXISTS'
  | 'DUPLICATE_PATIENT_SESSION'
  | 'SESSION_TRANSITION_REFUSED'
  | 'SURGERY_MISMATCH'
  | 'PREVIOUS_DECLINE'
  | 'SESSION_EXPIRED'
  | 'NOT_SET_UP'
  | 'ALREADY_SET_UP'
  | 'VERSION_CONFLICT'
  | 'DENTALLY_UNAVAILABLE'
  | 'DENTALLY_AUTH'
  | 'INTERNAL';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  NOT_FOUND: 404,
  PATIENT_MISMATCH: 409,
  NOT_TODAY: 409,
  APPOINTMENT_CLOSED: 409,
  PRACTITIONER_MISMATCH: 409,
  ACTIVE_SESSION_EXISTS: 409,
  DUPLICATE_PATIENT_SESSION: 409,
  SESSION_TRANSITION_REFUSED: 409,
  SURGERY_MISMATCH: 409,
  PREVIOUS_DECLINE: 409,
  SESSION_EXPIRED: 409,
  NOT_SET_UP: 409,
  ALREADY_SET_UP: 409,
  VERSION_CONFLICT: 409,
  DENTALLY_UNAVAILABLE: 503,
  DENTALLY_AUTH: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  /** Non-sensitive extra information for the UI, e.g. the ID of the session already active. */
  readonly details: Record<string, string | number | boolean | null>;

  constructor(code: AppErrorCode, message: string, details: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
