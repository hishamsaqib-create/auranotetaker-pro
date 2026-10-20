import { describe, expect, it } from 'vitest';
import { contentDeleteAfterMs, MAX_SEGMENTS_PER_SAVE, orderSegments, validateNurseNoteText, validateSegments } from './transcript.ts';

const seg = (o: Record<string, unknown> = {}) => ({ segmentId: 'abcdefgh-1', seq: 1, startMs: 0, endMs: 1200, speaker: 'S1', text: 'Lower left six.', ...o });

describe('validateSegments', () => {
  it('accepts well-formed segments, including an unknown speaker', () => {
    const r = validateSegments([seg(), seg({ segmentId: 'abcdefgh-2', seq: 2, speaker: null })]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['empty', []],
    ['not a list', 'text'],
    ['bad ID', [seg({ segmentId: 'x' })]],
    ['repeated ID', [seg(), seg()]],
    ['zero seq', [seg({ seq: 0 })]],
    ['end before start', [seg({ startMs: 500, endMs: 100 })]],
    ['speaker that looks like a name', [seg({ speaker: 'Oliver Bennett' })]],
    ['blank text', [seg({ text: '   ' })]],
    ['control characters', [seg({ text: 'a\u0007b' })]],
    ['too long', [seg({ text: 'a'.repeat(4001) })]],
  ])('refuses %s instead of repairing it', (_label, value) => {
    expect(validateSegments(value).ok).toBe(false);
  });

  it('caps the number of segments per save', () => {
    const many = Array.from({ length: MAX_SEGMENTS_PER_SAVE + 1 }, (_, i) => seg({ segmentId: `abcdefgh-${i}`, seq: i + 1 }));
    expect(validateSegments(many).ok).toBe(false);
  });
});

describe('validateNurseNoteText', () => {
  it('accepts empty and multi-line notes, refuses non-text', () => {
    expect(validateNurseNoteText('').ok).toBe(true);
    expect(validateNurseNoteText('Shade A2\nBatch 1234').ok).toBe(true);
    expect(validateNurseNoteText(42).ok).toBe(false);
    expect(validateNurseNoteText('x'.repeat(20_001)).ok).toBe(false);
  });
});

describe('orderSegments', () => {
  it('orders by sequence and keeps the first copy of a repeated ID', () => {
    const out = orderSegments([seg({ segmentId: 'abcdefgh-b', seq: 2, text: 'second' }), seg({ text: 'first' }), seg({ text: 'duplicate' })]);
    expect(out.map((s) => s.text)).toEqual(['second', 'first'].reverse());
  });
});

describe('contentDeleteAfterMs', () => {
  it('is midnight at the end of the next day in London', () => {
    const saved = Date.parse('2026-10-20T10:40:00+01:00');
    expect(new Date(contentDeleteAfterMs(saved, 'Europe/London')).toISOString()).toBe('2026-10-21T23:00:00.000Z');
  });

  it('handles the clocks going back (25-hour day)', () => {
    const saved = Date.parse('2026-10-24T18:00:00+01:00');
    // Midnight between Sunday 25 and Monday 26 October, after BST ends: 00:00 GMT.
    expect(new Date(contentDeleteAfterMs(saved, 'Europe/London')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('just before midnight still gets the whole of the next day', () => {
    const saved = Date.parse('2026-10-20T23:59:00+01:00');
    expect(new Date(contentDeleteAfterMs(saved, 'Europe/London')).toISOString()).toBe('2026-10-21T23:00:00.000Z');
  });
});
