import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteTemplate } from '../../lib/core/noteTemplates.ts';
import { fillTemplate, templateFields, unfilledBlanks } from '../../lib/core/noteTemplates.ts';
import type { NoteFinding } from '../../lib/core/noteCheck.ts';
import { quickCheckNote } from '../../lib/core/noteCheck.ts';
import type { CheckNoteResponse, GenerateNoteResponse } from '../../lib/server/handlers.ts';
import type { AppBackend } from '../backend/types.ts';
import { setNoteUncopied } from '../scribe/noteGuard.ts';
import { Notice } from './Notice.tsx';
import { TemplateManager } from './TemplateManager.tsx';

const BLANK = '__blank__';

export interface NoteWriterProps {
  backend: AppBackend;
  /** Who the note is for, when written inside a session: "Oliver Bennett, born 12 Mar 1986". */
  patientLabel: string | null;
  sessionId: string | null;
  /** Practice managers edit the clinic's templates; everyone else uses them. */
  canManageTemplates: boolean;
  /** Drafts the note with AI from the session's transcript and notes. Absent when AI may not be used. */
  generate?: (templateId: string | null, clinicianNotes: string) => Promise<GenerateNoteResponse>;
  /** Checks the note with AI against the session's transcript and notes. Absent when AI may not be used. */
  checkWithAi?: (note: string) => Promise<CheckNoteResponse>;
  /** Shown instead of the Generate button when AI is not available here, e.g. the patient declined. */
  generateUnavailable?: string | null;
  /** Injected in tests. */
  copyText?: (text: string) => Promise<void>;
}

/**
 * Writes a clinical note by hand, from one of the clinic's templates or from blank, for copying into Dentally.
 *
 * SAFETY: no AI and no recording are involved, so it is available even when a patient declined the scribe.
 * Nothing is stored: the note stays in this page until it is copied. Copying says which patient to paste into
 * (inside a session) or that no patient is selected, and warns about blanks still unfilled. The copy is audited
 * without its text. AuraNoteTaker never writes to Dentally; the clinician pastes the note.
 */
export function NoteWriter({ backend, patientLabel, sessionId, canManageTemplates, generate, checkWithAi, generateUnavailable, copyText }: NoteWriterProps) {
  const [templates, setTemplates] = useState<NoteTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>(BLANK);
  const [values, setValues] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [handEdited, setHandEdited] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  /** The note holds an AI draft: it must be checked, and ticked as checked, before copying. */
  const [aiDraft, setAiDraft] = useState(false);
  const [checkedDraft, setCheckedDraft] = useState(false);
  /** What the note was before the latest draft, including whether that was itself an AI draft. */
  const [beforeDraft, setBeforeDraft] = useState<{ text: string; aiDraft: boolean } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  /** The template as it was when chosen, so later edits to it cannot change what counts as unfilled. */
  const [chosen, setChosen] = useState<NoteTemplate | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  /** The latest check: the text it was run on, the fixed-rule findings and, if run, the AI's. */
  const [check, setCheck] = useState<{
    text: string;
    quick: NoteFinding[];
    ai: CheckNoteResponse | null;
    aiError: string | null;
    aiRunning: boolean;
  } | null>(null);

  const load = () => {
    setLoadError(null);
    backend
      .listNoteTemplates()
      .then((r) => setTemplates(r.templates))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'The templates could not be loaded.'));
  };
  useEffect(load, [backend]);

  // A note in progress is lost if the page closes: ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (textRef.current.trim()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const template = chosen;
  const fields = useMemo(() => (template ? templateFields(template.body) : []), [template]);
  // Anything left in brackets, whether from the template or typed by hand.
  const remaining = unfilledBlanks(text);

  // Tell the rest of the app when there is a note that has not been copied, so leaving can ask first.
  useEffect(() => {
    setNoteUncopied(text.trim() !== '' && copied === null);
  }, [text, copied]);
  useEffect(() => () => setNoteUncopied(false), []);

  function chooseTemplate(id: string) {
    if (textRef.current.trim() && !window.confirm?.('Start again with this template? The note below will be replaced.')) return;
    setTemplateId(id);
    setValues({});
    setHandEdited(false);
    setCopied(null);
    setAiDraft(false);
    setBeforeDraft(null);
    const t = templates?.find((x) => x.templateId === id) ?? null;
    setChosen(t ? { ...t } : null);
    setText(t ? fillTemplate(t.body, {}) : '');
  }

  function setValue(label: string, v: string) {
    const next = { ...values, [label.toLowerCase()]: v };
    setValues(next);
    setCopied(null);
    if (template && !handEdited) setText(fillTemplate(template.body, next));
  }

  async function draftWithAi() {
    if (!generate) return;
    setGenerateError(null);
    setGenerating(true);
    // What the clinician has written or filled in is part of the source; an untouched template is not.
    const untouched = template ? fillTemplate(template.body, {}) : '';
    const own = text.trim() === untouched.trim() ? '' : text;
    try {
      const r = await generate(template?.templateId ?? null, own);
      setBeforeDraft({ text, aiDraft });
      setText(r.draft);
      setAiDraft(true);
      setCheckedDraft(false);
      setHandEdited(true);
      setCopied(null);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'The note could not be drafted. Try again, or write it from the template.');
    } finally {
      setGenerating(false);
    }
  }

  async function runCheck() {
    const checkedText = text;
    const quick = quickCheckNote(checkedText);
    setCheck({ text: checkedText, quick, ai: null, aiError: null, aiRunning: Boolean(checkWithAi) });
    if (!checkWithAi) return;
    try {
      const ai = await checkWithAi(checkedText);
      setCheck((c) => (c && c.text === checkedText ? { ...c, ai, aiRunning: false } : c));
    } catch (err) {
      const aiError = err instanceof Error ? err.message : 'The AI check did not work. Check the note yourself.';
      setCheck((c) => (c && c.text === checkedText ? { ...c, aiError, aiRunning: false } : c));
    }
  }

  async function copy() {
    setCopyError(null);
    try {
      await (copyText ?? ((t: string) => navigator.clipboard.writeText(t)))(text);
    } catch {
      setCopyError('The note could not be copied automatically. Select the text below, copy it (Cmd + C or Ctrl + C) and paste it into Dentally.');
      return;
    }
    const where = patientLabel ? `Paste it into the notes for ${patientLabel} in Dentally.` : "Paste it into the right patient's notes in Dentally.";
    setCopied(remaining.length ? `Copied with ${remaining.length} blank${remaining.length === 1 ? '' : 's'} still in brackets (${remaining.join(', ')}). ${where}` : `Copied. ${where}`);
    // Audit that a note was produced (never its text). A failure here is shown, but the copy has happened.
    backend
      .recordNoteCopied({ sessionId, templateId: template?.templateId ?? null, unfilledCount: remaining.length, aiDraft })
      .catch(() => setCopyError('Copied, but the copy could not be added to the audit trail. Please tell the practice manager.'));
  }

  if (managing) {
    return (
      <TemplateManager
        backend={backend}
        onClose={() => {
          setManaging(false);
          load();
        }}
      />
    );
  }

  return (
    <section className="note-writer" aria-labelledby="note-writer-heading">
      <div className="state-heading">
        <h2 id="note-writer-heading">Write the note</h2>
        {canManageTemplates && (
          <button type="button" className="link-button" onClick={() => setManaging(true)}>
            Manage templates
          </button>
        )}
      </div>
      {patientLabel ? (
        <p className="note-for">
          For <strong>{patientLabel}</strong>. Paste it into this patient's notes in Dentally.
        </p>
      ) : (
        <Notice tone="warn" title="No patient selected">
          This note is not linked to a patient. Make sure you paste it into the right patient's notes in Dentally.
        </Notice>
      )}
      {loadError && (
        <Notice
          tone="bad"
          title={loadError}
          action={
            <button type="button" className="button button-secondary" onClick={load}>
              Try again
            </button>
          }
        />
      )}

      <label className="field">
        <span className="field-label">Template</span>
        <select value={templateId} onChange={(e) => chooseTemplate(e.target.value)} disabled={!templates || generating}>
          <option value={BLANK}>Blank note (write it yourself)</option>
          {(templates ?? []).map((t) => (
            <option key={t.templateId} value={t.templateId}>
              {t.title}
            </option>
          ))}
        </select>
      </label>

      {fields.length > 0 && (
        <fieldset className="note-fields">
          <legend className="field-label">Fill in</legend>
          {fields.map((f) => {
            const id = `field-${f.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            return (
              <label key={f.label} className="field note-field">
                <span className="field-label">{f.label}</span>
                <input
                  className="input"
                  list={f.options.length ? `${id}-options` : undefined}
                  value={values[f.label.toLowerCase()] ?? ''}
                  disabled={generating}
                  placeholder={f.options.length ? 'Choose or type' : ''}
                  onChange={(e) => setValue(f.label, e.target.value)}
                />
                {f.options.length > 0 && (
                  <datalist id={`${id}-options`}>
                    {f.options.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                )}
              </label>
            );
          })}
        </fieldset>
      )}

      {generate ? (
        <div className="generate-row">
          <button type="button" className="button button-secondary" disabled={generating || !templates} onClick={() => void draftWithAi()}>
            {generating ? 'Drafting the note…' : 'Generate note'}
          </button>
          <span className="admin-sub">
            Drafts the note{template ? ' in this template' : ''} from the transcript, the nurse notes and anything you have written below.
          </span>
        </div>
      ) : (
        generateUnavailable && <p className="admin-sub">{generateUnavailable}</p>
      )}
      {generateError && <Notice tone="bad" title={generateError} />}
      {aiDraft && (
        <Notice tone="warn" title="AI draft: check every line against what happened before copying">
          The draft only uses the transcript and notes, but it can still be wrong. Anything in square brackets was not covered or needs checking.
          {beforeDraft !== null && (
            <>
              {' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setText(beforeDraft.text);
                  setAiDraft(beforeDraft.aiDraft);
                  setBeforeDraft(null);
                  setCheckedDraft(false);
                }}
              >
                Undo the draft
              </button>
            </>
          )}
        </Notice>
      )}

      <label className="field">
        <span className="field-label">Note</span>
        <textarea
          className="note-text"
          value={text}
          rows={14}
          // Locked while drafting, so nothing typed meanwhile is overwritten by the draft.
          readOnly={generating}
          placeholder={template ? '' : 'Write the note here.'}
          onChange={(e) => {
            setText(e.target.value);
            setCopied(null);
            if (template) setHandEdited(true);
          }}
        />
      </label>
      {template && handEdited && (
        <p className="state-lead">
          You have edited the note by hand, so the boxes above no longer change it.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setText(fillTemplate(template.body, values));
              setHandEdited(false);
            }}
          >
            Rebuild it from the boxes
          </button>
        </p>
      )}
      {remaining.length > 0 && (
        <Notice tone="warn" title={`Still to fill in: ${remaining.join(', ')}`}>
          They will appear in brackets in the note until you fill them in or delete them.
        </Notice>
      )}
      {template?.starter && (
        <p className="state-lead">
          This is a starter template: check the wording before copying.
          {canManageTemplates ? ' Make the clinic\'s own version under Manage templates.' : ''}
        </p>
      )}
      <div className="generate-row">
        <button type="button" className="button button-secondary" disabled={!text.trim() || generating || check?.aiRunning === true} onClick={() => void runCheck()}>
          {check?.aiRunning ? 'Checking the note…' : 'Check for contradictions'}
        </button>
        <span className="admin-sub">
          {checkWithAi
            ? 'Looks for statements that disagree with each other or with the transcript and nurse notes.'
            : 'Looks for common statements that disagree with each other. Checked on this computer; nothing is sent anywhere.'}
        </span>
      </div>
      {check && <CheckResults check={check} stale={check.text !== text} />}
      {copied && <Notice tone="info" title={copied} />}
      {copyError && <Notice tone="bad" title={copyError} />}
      <div className="actions">
        {aiDraft && (
          <label className="admin-check">
            <input type="checkbox" checked={checkedDraft} onChange={(e) => setCheckedDraft(e.target.checked)} />
            <span>I have checked every line of this draft</span>
          </label>
        )}
        <button type="button" className="button button-primary" disabled={!text.trim() || (aiDraft && !checkedDraft)} onClick={() => void copy()}>
          Copy for Dentally
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={!text.trim()}
          onClick={() => {
            if (window.confirm?.('Clear this note?') === false) return;
            setText('');
            setValues({});
            setHandEdited(false);
            setCopied(null);
            setAiDraft(false);
            setBeforeDraft(null);
          }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

const KIND_LABEL: Record<NoteFinding['kind'], string> = {
  CONTRADICTION: 'Contradiction',
  NOT_IN_SOURCES: 'Not in the transcript or nurse notes',
  UNCLEAR: 'Unclear',
  UNFINISHED: 'Still to check',
};

function FindingList({ findings }: { findings: NoteFinding[] }) {
  return (
    <ul className="check-findings">
      {findings.map((f, i) => (
        <li key={i} className={`check-finding check-${f.kind.toLowerCase()}`}>
          <span className="check-kind">{KIND_LABEL[f.kind]}</span> {f.message}
          {f.quotes.length > 0 && (
            <ul className="check-quotes">
              {f.quotes.map((q, j) => (
                <li key={j}>
                  <q>{q}</q>
                </li>
              ))}
            </ul>
          )}
          {!f.quotesFound && <p className="admin-sub">These words are not in the note exactly as quoted: find the line yourself.</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the check found. SAFETY: findings are pointers for the clinician, never corrections, and "nothing found" is
 * worded so it cannot be read as the note being right.
 */
function CheckResults({
  check,
  stale,
}: {
  check: { quick: NoteFinding[]; ai: CheckNoteResponse | null; aiError: string | null; aiRunning: boolean };
  stale: boolean;
}) {
  // A point the quick check already raised about the same lines is shown once.
  const quick = check.quick;
  const seen = new Set(quick.flatMap((f) => f.quotes));
  const ai = (check.ai?.findings ?? []).filter((f) => f.quotes.length === 0 || !f.quotes.every((q) => seen.has(q)));
  const all = [...quick, ...ai];
  return (
    <section className="check-results" aria-label="Note check">
      {stale && <Notice tone="warn" title="The note has changed since it was checked. Check it again before copying." />}
      {all.length > 0 ? (
        <Notice tone="warn" title={`${all.length} point${all.length === 1 ? '' : 's'} to look at again`}>
          <FindingList findings={all} />
        </Notice>
      ) : (
        !check.aiRunning &&
        !check.aiError && (
          <Notice tone="info" title="No contradictions found">
            {check.ai
              ? `The AI check${check.ai.comparedWithSources ? ' compared the note with the transcript and nurse notes and' : ''} found nothing to point out.`
              : 'The quick check only looks for a few common slips.'}{' '}
            This does not replace your own check of every line.
          </Notice>
        )
      )}
      {check.aiRunning && <p className="state-lead">The AI is checking the note…</p>}
      {check.aiError && <Notice tone="bad" title={check.aiError} />}
    </section>
  );
}
