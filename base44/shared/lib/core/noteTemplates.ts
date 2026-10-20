// GENERATED from lib/core/noteTemplates.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Note templates: the clinic's own wording for common appointments, with blanks to fill in. Pure.
//
// Template syntax, chosen to be easy to type in a plain text box:
//   [Tooth]                          a blank to fill in
//   [Consent: verbal / written]      a choice; the options are separated by "/"
// A blank used twice is filled once. Anything else in square brackets that is empty or too long is left as text.
//
// SAFETY (clinical record): a blank left empty stays visible in the note as "[Tooth]", never silently dropped,
// so an unfinished note cannot pass for a finished one. Templates hold no patient data.

import { STARTER_TEMPLATE_DATA } from './starterTemplates.ts';

export interface TemplateField {
  /** As written, without the options, e.g. "Consent". Unique within a template (case-insensitive). */
  label: string;
  /** Empty for a free-text blank. */
  options: string[];
}

export interface NoteTemplate {
  templateId: string;
  title: string;
  body: string;
  active: boolean;
  /** Built into AuraNoteTaker: read-only, copied to make the clinic's own version. */
  starter: boolean;
  updatedBy: string | null;
  updatedAtMs: number | null;
}

export const MAX_TEMPLATE_TITLE = 80;
export const MAX_TEMPLATE_BODY = 10_000;
const MAX_FIELD = 120;
const FIELD = /\[([^\[\]\n]{1,120})\]/g;

function splitField(inner: string): TemplateField | null {
  const colon = inner.indexOf(':');
  const label = (colon >= 0 ? inner.slice(0, colon) : inner).trim();
  if (!label || label.length > 60) return null;
  const options =
    colon >= 0
      ? inner
          .slice(colon + 1)
          .split('/')
          .map((o) => o.trim())
          .filter(Boolean)
      : [];
  return { label, options };
}

const key = (label: string) => label.toLowerCase();

/** The blanks in a template, in order of first use. */
export function templateFields(body: string): TemplateField[] {
  const out: TemplateField[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(FIELD)) {
    if (m[1]!.length > MAX_FIELD) continue;
    const f = splitField(m[1]!);
    if (!f || seen.has(key(f.label))) continue;
    seen.add(key(f.label));
    out.push(f);
  }
  return out;
}

/**
 * The note with blanks filled in. A blank with no value keeps its label in brackets ("[Tooth]"), so it shows
 * as unfinished. Values are used as typed.
 */
export function fillTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(FIELD, (whole, inner: string) => {
    const f = splitField(inner);
    if (!f) return whole;
    const v = values[key(f.label)] ?? values[f.label];
    return v !== undefined && v.trim() !== '' ? v.trim() : `[${f.label}]`;
  });
}

/**
 * Anything still in square brackets in a finished note, so the screen can warn before copying. Looks at the
 * note itself, not the template, so it also catches blanks typed or pasted by hand.
 */
export function unfilledBlanks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FIELD)) {
    const label = m[1]!.trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

export type TemplateCheck = { ok: true; title: string; body: string } | { ok: false; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function checkTemplate(title: unknown, body: unknown): TemplateCheck {
  if (typeof title !== 'string' || typeof body !== 'string') return { ok: false, message: 'Give the template a name and some text.' };
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > MAX_TEMPLATE_TITLE || CONTROL.test(t)) return { ok: false, message: 'Give the template a name (up to 80 characters).' };
  const b = body.replace(/\r\n/g, '\n');
  if (b.trim().length === 0) return { ok: false, message: 'The template has no text.' };
  if (b.length > MAX_TEMPLATE_BODY || CONTROL.test(b)) return { ok: false, message: 'The template text is too long or contains characters that cannot be saved.' };
  for (const m of b.matchAll(/\[([^\[\]\n]*)\]/g)) {
    const f = splitField(m[1]!);
    if (!f) return { ok: false, message: `The blank "[${m[1]!.slice(0, 40)}]" needs a short name (up to 60 characters) before any colon.` };
  }
  return { ok: true, title: t, body: b };
}

/**
 * Starter templates (lib/core/starterTemplates.ts): read-only starting points for the clinic to check and make its
 * own. Every clinician checks every note before it goes into Dentally.
 */
export const STARTER_TEMPLATES: readonly NoteTemplate[] = STARTER_TEMPLATE_DATA.map((t) => ({
  templateId: t.id,
  title: `${t.title} (starter)`,
  body: t.lines.join('\n'),
  active: true,
  starter: true,
  updatedBy: null,
  updatedAtMs: null,
}));
