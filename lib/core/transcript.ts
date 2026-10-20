// Transcript segments and nurse notes: validation and retention rules. Pure.
//
// SAFETY and PRIVACY (decisions D2a, D6, D7):
// - Transcript text and nurse notes are clinical content. They are stored encrypted, only until the end of
//   the next day in the clinic's time zone, and never copied into audit metadata or logs.
// - Segments carry a client-made ID so a save that is retried after a timeout cannot duplicate text.
// - Nothing here guesses: a segment that fails validation is refused, not trimmed or repaired.

import { zonedDateString } from './time.ts';

/** One finished piece of transcript, as sent by the scribe screen. Times are offsets into the recording. */
export interface TranscriptSegmentInput {
  /** Made by the screen (random). Saving the same ID twice stores it once. */
  segmentId: string;
  /** Order within the session, counting from 1. */
  seq: number;
  startMs: number;
  endMs: number;
  /** Speaker label from speech-to-text ("S1", "S2"), or null when not known. Not a person's name. */
  speaker: string | null;
  text: string;
}

export interface TranscriptSegment extends TranscriptSegmentInput {
  capturedBy: string;
  savedAtMs: number;
}

export interface NurseNote {
  text: string;
  /** Starts at 1 and goes up with every save. Saves name the revision they edited, so two screens cannot overwrite each other. */
  revision: number;
  updatedBy: string;
  updatedAtMs: number;
}

export const MAX_SEGMENTS_PER_SAVE = 50;
export const MAX_SEGMENT_TEXT = 4000;
export const MAX_NURSE_NOTE_TEXT = 20_000;
/** Longest recording offset accepted: 12 hours. */
const MAX_OFFSET_MS = 12 * 60 * 60_000;

const SEGMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SPEAKER = /^[A-Za-z0-9_]{1,8}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export function validateSegments(raw: unknown): ValidationResult<TranscriptSegmentInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: 'No transcript to save.' };
  if (raw.length > MAX_SEGMENTS_PER_SAVE) return { ok: false, message: 'Too much transcript in one save.' };
  const out: TranscriptSegmentInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, message: 'A transcript segment could not be read.' };
    const s = item as Record<string, unknown>;
    if (typeof s.segmentId !== 'string' || !SEGMENT_ID.test(s.segmentId)) return { ok: false, message: 'A transcript segment has no valid ID.' };
    if (seen.has(s.segmentId)) return { ok: false, message: 'A transcript segment was sent twice.' };
    if (!isInt(s.seq, 1, 1_000_000)) return { ok: false, message: 'A transcript segment is out of order.' };
    if (!isInt(s.startMs, 0, MAX_OFFSET_MS) || !isInt(s.endMs, 0, MAX_OFFSET_MS) || s.endMs < s.startMs) {
      return { ok: false, message: 'A transcript segment has invalid times.' };
    }
    if (s.speaker !== null && (typeof s.speaker !== 'string' || !SPEAKER.test(s.speaker))) {
      return { ok: false, message: 'A transcript segment has an invalid speaker label.' };
    }
    if (typeof s.text !== 'string' || s.text.trim().length === 0 || s.text.length > MAX_SEGMENT_TEXT || CONTROL.test(s.text)) {
      return { ok: false, message: 'A transcript segment has invalid text.' };
    }
    seen.add(s.segmentId);
    out.push({ segmentId: s.segmentId, seq: s.seq, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text });
  }
  return { ok: true, value: out };
}

export function validateNurseNoteText(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return { ok: false, message: 'The nurse notes could not be read.' };
  if (raw.length > MAX_NURSE_NOTE_TEXT) return { ok: false, message: 'The nurse notes are too long.' };
  if (CONTROL.test(raw)) return { ok: false, message: 'The nurse notes contain characters that cannot be saved.' };
  return { ok: true, value: raw };
}

/** Segments in recording order, one per ID (the first stored wins). */
export function orderSegments<T extends TranscriptSegmentInput>(segments: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of segments) if (!byId.has(s.segmentId)) byId.set(s.segmentId, s);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.startMs - b.startMs || (a.segmentId < b.segmentId ? -1 : 1));
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * When clinical content saved at `nowMs` must be deleted: the start of the day after the next day in the
 * clinic's time zone (so content saved on Monday goes at midnight between Tuesday and Wednesday).
 * Correct across clock changes.
 */
export function contentDeleteAfterMs(nowMs: number, timeZone: string): number {
  const target = addDays(zonedDateString(nowMs, timeZone), 2);
  // Smallest whole minute on the target date. Midnight always falls on a whole minute.
  let lo = Math.floor(nowMs / 60_000);
  let hi = lo + 4 * 24 * 60;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zonedDateString(mid * 60_000, timeZone) >= target) hi = mid;
    else lo = mid;
  }
  return hi * 60_000;
}
