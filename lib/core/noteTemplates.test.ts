import { describe, expect, it } from 'vitest';
import { checkTemplate, fillTemplate, STARTER_TEMPLATES, templateFields, unfilledBlanks } from './noteTemplates.ts';

const body = 'Composite [Tooth] [Surfaces]\nConsent: [Consent: verbal / written]\nLA: [Anaesthetic: articaine 4% 1:100,000 / none]\nRecheck [tooth] next visit.';

describe('note templates', () => {
  it('finds blanks and choices once each, in order, case-insensitively', () => {
    expect(templateFields(body)).toEqual([
      { label: 'Tooth', options: [] },
      { label: 'Surfaces', options: [] },
      { label: 'Consent', options: ['verbal', 'written'] },
      { label: 'Anaesthetic', options: ['articaine 4% 1:100,000', 'none'] },
    ]);
  });

  it('fills every use of a blank and keeps unfilled blanks visible', () => {
    const out = fillTemplate(body, { tooth: 'LL6', consent: 'verbal' });
    expect(out).toContain('Composite LL6 [Surfaces]');
    expect(out).toContain('Recheck LL6 next visit.');
    expect(out).toContain('Consent: verbal');
    expect(out).toContain('LA: [Anaesthetic]');
    expect(unfilledBlanks(out)).toEqual(['Surfaces', 'Anaesthetic']);
    expect(unfilledBlanks('Typed by hand [Tooth] and [Shade]')).toEqual(['Tooth', 'Shade']);
  });

  it('treats a blank filled with spaces as unfilled', () => {
    expect(fillTemplate('[Tooth]', { tooth: '   ' })).toBe('[Tooth]');
  });

  it('leaves empty or overlong brackets as text', () => {
    expect(templateFields('a [] b [' + 'x'.repeat(130) + ']')).toEqual([]);
  });

  it('checks names and text', () => {
    expect(checkTemplate('  Root  canal ', 'Text')).toEqual({ ok: true, title: 'Root canal', body: 'Text' });
    expect(checkTemplate('X', 'Text').ok).toBe(false);
    expect(checkTemplate('Name', '   ').ok).toBe(false);
    expect(checkTemplate('Name', 'a\u0007b').ok).toBe(false);
    expect(checkTemplate('Name', 'x'.repeat(10_001)).ok).toBe(false);
    expect(checkTemplate('Name', '[' + 'Describe the procedure and any complications encountered today' + ']').ok).toBe(false);
    expect(checkTemplate('Name', 'Empty [] blank').ok).toBe(false);
  });

  it('ships a full set of starter templates with unique IDs and names', () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(STARTER_TEMPLATES.map((t) => t.templateId)).size).toBe(STARTER_TEMPLATES.length);
    expect(new Set(STARTER_TEMPLATES.map((t) => t.title)).size).toBe(STARTER_TEMPLATES.length);
    // Earlier starter IDs are kept, so audit records that name them still make sense.
    for (const id of ['starter-examination', 'starter-composite', 'starter-extraction', 'starter-hygiene', 'starter-aligner-review']) {
      expect(STARTER_TEMPLATES.some((t) => t.templateId === id)).toBe(true);
    }
  });

  it('gives every starter template blanks with short, consistent names', () => {
    for (const t of STARTER_TEMPLATES) {
      const fields = templateFields(t.body);
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) expect(f.label.length).toBeLessThanOrEqual(40);
      // A blank used twice in one template must offer the same options, or the second would be ignored.
      const seen = new Map<string, string>();
      for (const m of t.body.matchAll(/\[([^\[\]\n]{1,120})\]/g)) {
        const [label, opts = ''] = m[1]!.split(/:(.*)/s);
        const k = label!.trim().toLowerCase();
        if (seen.has(k)) expect(opts.trim(), `${t.title}: ${label}`).toBe(seen.get(k));
        else seen.set(k, opts.trim());
      }
    }
  });

  it('ships starter templates that are valid, marked as starters, and use Aura tooth notation', () => {
    for (const t of STARTER_TEMPLATES) {
      expect(checkTemplate(t.title, t.body).ok).toBe(true);
      expect(t.starter).toBe(true);
      expect(t.title).toMatch(/\(starter\)$/);
      expect(t.body).not.toMatch(/\btooth (number )?\d{1,2}\b/i);
    }
  });
});
