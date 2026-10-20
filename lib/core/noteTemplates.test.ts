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

  it('ships starter templates that are valid, marked as starters, and use Aura tooth notation', () => {
    for (const t of STARTER_TEMPLATES) {
      expect(checkTemplate(t.title, t.body).ok).toBe(true);
      expect(t.starter).toBe(true);
      expect(t.title).toMatch(/\(starter\)$/);
      expect(t.body).not.toMatch(/\btooth (number )?\d{1,2}\b/i);
    }
  });
});
