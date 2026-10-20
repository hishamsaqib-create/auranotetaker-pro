// GENERATED from lib/dentally/parse.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Validation of Dentally API responses.
//
// SAFETY: anything that does not look exactly right is rejected and counted, never
// repaired by guesswork. Rejection reasons are codes only: they never include the record,
// so patient data cannot leak into logs through error messages.

import type { AppointmentState, DiaryAppointment } from '../core/appointments.ts';
import { KNOWN_APPOINTMENT_STATES } from '../core/appointments.ts';
import { formatCalendarDate, parseZonedIso } from '../core/time.ts';
import type { PatientSummary, PractitionerSummary, RoomSummary } from './types.ts';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: ParseRejection };

export type ParseRejection =
  | 'NOT_AN_OBJECT'
  | 'MISSING_ID'
  | 'MISSING_PRACTITIONER'
  | 'BAD_TIMES'
  | 'MISSING_NAME';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Dentally IDs are numbers in v1. Accept numbers or numeric/alphanumeric strings; return a string. */
export function toId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
  return null;
}

const toStr = (v: unknown, max = 120): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const STATE_LOOKUP = new Map(KNOWN_APPOINTMENT_STATES.map((s) => [s.toLowerCase(), s]));

/** Maps Dentally's state string to a known state, tolerating case and underscores ("in_surgery"). Anything else is Unknown. */
export function normaliseState(raw: unknown): { state: AppointmentState; rawState: string | null } {
  if (typeof raw !== 'string' || !raw.trim()) return { state: 'Unknown', rawState: null };
  const key = raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const known = STATE_LOOKUP.get(key);
  return known ? { state: known, rawState: null } : { state: 'Unknown', rawState: raw.trim().slice(0, 40) };
}

export function parseAppointment(raw: unknown): ParseResult<DiaryAppointment> {
  if (!isObj(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  const appointmentId = toId(raw.id);
  if (!appointmentId) return { ok: false, reason: 'MISSING_ID' };
  const practitionerId = toId(raw.practitioner_id);
  if (!practitionerId) return { ok: false, reason: 'MISSING_PRACTITIONER' };
  const startMs = parseZonedIso(raw.start_time);
  const finishMs = parseZonedIso(raw.finish_time);
  if (startMs === null || finishMs === null || finishMs <= startMs) return { ok: false, reason: 'BAD_TIMES' };
  const { state, rawState } = normaliseState(raw.state);
  const patientId = raw.patient_id === null || raw.patient_id === undefined ? null : toId(raw.patient_id);
  return {
    ok: true,
    value: {
      appointmentId,
      patientId,
      patientName: patientId === null ? null : toStr(raw.patient_name),
      practitionerId,
      roomId: raw.room_id === null || raw.room_id === undefined ? null : toId(raw.room_id),
      startMs,
      finishMs,
      state,
      rawState,
      reason: toStr(raw.reason, 60),
      inSurgeryAtMs: parseZonedIso(raw.in_surgery_at),
      arrivedAtMs: parseZonedIso(raw.arrived_at),
      completedAtMs: parseZonedIso(raw.completed_at),
    },
  };
}

export function parsePatient(raw: unknown): ParseResult<PatientSummary> {
  if (!isObj(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  const patientId = toId(raw.id);
  if (!patientId) return { ok: false, reason: 'MISSING_ID' };
  const displayName = [toStr(raw.first_name, 60), toStr(raw.last_name, 60)].filter(Boolean).join(' ');
  if (!displayName) return { ok: false, reason: 'MISSING_NAME' };
  const dob = typeof raw.date_of_birth === 'string' ? raw.date_of_birth.slice(0, 10) : null;
  return {
    ok: true,
    value: { patientId, displayName, dateOfBirth: dob && formatCalendarDate(dob) ? dob : null },
  };
}

export function parsePractitioner(raw: unknown): ParseResult<PractitionerSummary> {
  if (!isObj(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  const practitionerId = toId(raw.id);
  if (!practitionerId) return { ok: false, reason: 'MISSING_ID' };
  const user = isObj(raw.user) ? raw.user : {};
  const name = [toStr(user.title, 10), toStr(user.first_name, 60), toStr(user.last_name, 60)].filter(Boolean).join(' ');
  if (!name) return { ok: false, reason: 'MISSING_NAME' };
  return {
    ok: true,
    value: {
      practitionerId,
      userId: toId(user.id),
      displayName: name,
      // Inactive if Dentally marks the practitioner or their user account inactive.
      active: raw.active !== false && user.active !== false,
    },
  };
}

export function parseRoom(raw: unknown): ParseResult<RoomSummary> {
  if (!isObj(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  const roomId = toId(raw.id);
  if (!roomId) return { ok: false, reason: 'MISSING_ID' };
  const name = toStr(raw.name, 60);
  if (!name) return { ok: false, reason: 'MISSING_NAME' };
  return { ok: true, value: { roomId, name, siteId: raw.site_id === undefined || raw.site_id === null ? null : toId(raw.site_id) } };
}

/** Finds the list in a Dentally list response: `{ appointments: [...], meta }`, or a bare array. */
export function extractList(body: unknown, key: string): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (isObj(body) && Array.isArray(body[key])) return body[key] as unknown[];
  return null;
}

/** Finds the record in a Dentally single-record response: `{ appointment: {...} }`, or the bare object. */
export function extractOne(body: unknown, key: string): unknown {
  if (isObj(body) && isObj(body[key])) return body[key];
  return body;
}

/** Total pages from Dentally list metadata when present. */
export function totalPages(body: unknown): number | null {
  if (!isObj(body) || !isObj(body.meta)) return null;
  const tp = body.meta.total_pages;
  return typeof tp === 'number' && Number.isInteger(tp) && tp >= 0 ? tp : null;
}
