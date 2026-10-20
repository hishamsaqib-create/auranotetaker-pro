// Note templates: the clinic's own wording for common appointments, with blanks to fill in. Pure.
//
// Template syntax, chosen to be easy to type in a plain text box:
//   [Tooth]                          a blank to fill in
//   [Consent: verbal / written]      a choice; the options are separated by "/"
// A blank used twice is filled once. Anything else in square brackets that is empty or too long is left as text.
//
// SAFETY (clinical record): a blank left empty stays visible in the note as "[Tooth]", never silently dropped,
// so an unfinished note cannot pass for a finished one. Templates hold no patient data.

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
 * Starter templates. Generic wording for the clinic to check, change and make its own: every clinician
 * must review a note before it goes into Dentally. Tooth notation follows Aura's style (UR1, LL6; decision D5).
 */
export const STARTER_TEMPLATES: readonly NoteTemplate[] = [
  {
    templateId: 'starter-examination',
    title: 'Examination (starter)',
    body: [
      'Examination',
      'C/O: [Complaint]',
      'MH: [Medical history: reviewed, no changes / reviewed, changes noted]',
      'E/O: [Extra-oral: NAD / see notes]',
      'I/O: soft tissues [Soft tissues: NAD / see notes]',
      'BPE: [BPE]',
      'Charting updated: [Charting updated: yes / no]',
      'Radiographs: [Radiographs: none taken / bitewings taken, reported / OPG taken, reported]',
      'Diagnosis: [Diagnosis]',
      'Options discussed, including risks, benefits and costs: [Options]',
      'Patient choice: [Plan]',
      'OHI given: [OHI: yes / no]',
      'Recall: [Recall: 6 months / 9 months / 12 months]',
    ].join('\n'),
    active: true,
    starter: true,
    updatedBy: null,
    updatedAtMs: null,
  },
  {
    templateId: 'starter-composite',
    title: 'Composite restoration (starter)',
    body: [
      'Composite restoration [Tooth] [Surfaces]',
      'MH: [Medical history: reviewed, no changes / reviewed, changes noted]',
      'Consent: [Consent: verbal / written] consent obtained after discussing risks, benefits and alternatives.',
      'LA: [Anaesthetic: articaine 4% 1:100,000 / lidocaine 2% 1:80,000 / none] [Amount] [Technique: infiltration / IDB]',
      'Isolation: [Isolation: rubber dam / cotton wool rolls]',
      'Caries removed, [Lining: no lining / lining placed]',
      'Composite: [Shade], bonded and placed incrementally, occlusion checked.',
      'Post-op advice given.',
    ].join('\n'),
    active: true,
    starter: true,
    updatedBy: null,
    updatedAtMs: null,
  },
  {
    templateId: 'starter-extraction',
    title: 'Extraction (starter)',
    body: [
      'Extraction [Tooth]',
      'MH: [Medical history: reviewed, no changes / reviewed, changes noted]',
      'Consent: [Consent: verbal / written] consent obtained, including risks of pain, swelling, bleeding, infection and dry socket.',
      'LA: [Anaesthetic: articaine 4% 1:100,000 / lidocaine 2% 1:80,000] [Amount] [Technique: infiltration / IDB]',
      'Extraction: [Method: simple forceps / elevators and forceps / surgical]',
      'Haemostasis achieved: [Haemostasis: yes / with sutures]',
      'Post-op instructions given verbally and in writing.',
    ].join('\n'),
    active: true,
    starter: true,
    updatedBy: null,
    updatedAtMs: null,
  },
  {
    templateId: 'starter-hygiene',
    title: 'Hygiene visit (starter)',
    body: [
      'Hygiene visit',
      'MH: [Medical history: reviewed, no changes / reviewed, changes noted]',
      'BPE: [BPE]',
      'Plaque and bleeding: [Plaque and bleeding]',
      'Treatment: [Treatment: supragingival scale and polish / subgingival debridement]',
      'OHI: [OHI given]',
      'Recall: [Recall: 3 months / 4 months / 6 months]',
    ].join('\n'),
    active: true,
    starter: true,
    updatedBy: null,
    updatedAtMs: null,
  },
  {
    templateId: 'starter-aligner-review',
    title: 'Aligner review (starter)',
    body: [
      'Aligner review',
      'Currently on aligner [Aligner number] of [Total aligners]',
      'Fit and tracking: [Tracking: good / poor, see notes]',
      'Attachments: [Attachments: all present / replaced]',
      'IPR: [IPR: none / done as planned]',
      'Compliance: [Compliance: good / reinforced]',
      'Next aligners issued: [Next aligners]',
      'Next review: [Next review]',
    ].join('\n'),
    active: true,
    starter: true,
    updatedBy: null,
    updatedAtMs: null,
  },
];
