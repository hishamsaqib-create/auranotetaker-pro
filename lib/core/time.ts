// Clinic time zone helpers. Dependency-free; runs in browsers, Deno and Node.
//
// All instants are epoch milliseconds. All "dates" are YYYY-MM-DD strings in the
// clinic's time zone. Nothing here uses the host machine's local time zone, so
// results are the same on a surgery PC and on a server running in UTC.

export const DEFAULT_TIME_ZONE = 'Europe/London';

export const MINUTE_MS = 60_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const out: Partial<ZonedParts> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day' || p.type === 'hour' || p.type === 'minute') {
      out[p.type] = p.value;
    }
  }
  return out as ZonedParts;
}

/** The calendar date (YYYY-MM-DD) of an instant in the given time zone. */
export function zonedDateString(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 24-hour clock time (HH:MM) of an instant in the given time zone. */
export function formatClock(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(ms, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** "10:30–11:15" in the given time zone. */
export function formatTimeRange(startMs: number, finishMs: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  return `${formatClock(startMs, timeZone)}–${formatClock(finishMs, timeZone)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Mar 1988" from "1988-03-12". Returns null for anything that is not a valid calendar date. */
export function formatCalendarDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses an ISO 8601 date-time that carries an explicit offset or Z.
 * Date-times without a zone are rejected (returns null): interpreting them would
 * depend on the machine's time zone, which differs between surgery PCs and servers.
 */
export function parseZonedIso(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole minutes from a to b (b - a), rounded towards zero. */
export function minutesBetween(aMs: number, bMs: number): number {
  return Math.trunc((bMs - aMs) / MINUTE_MS);
}
