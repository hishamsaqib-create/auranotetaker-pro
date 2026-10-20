import { useEffect, useState } from 'react';
import type { NoteTemplate } from '../../lib/core/noteTemplates.ts';
import { checkTemplate, templateFields } from '../../lib/core/noteTemplates.ts';
import type { AppBackend } from '../backend/types.ts';
import { Notice } from './Notice.tsx';

interface Draft {
  templateId: string | null;
  title: string;
  body: string;
  active: boolean;
}

/**
 * Splits pasted text into templates: each starts with a line beginning "##", which is its name; the lines up to
 * the next "##" are its text. This is how templates are brought over from Dentally, which has no way to export
 * them through its API.
 */
export function parseTemplateImport(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    // Exactly two hashes: "###" lines inside a template stay part of its text.
    const heading = /^##(?!#)\s*(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) out.push({ title: current.title, body: current.lines.join('\n').trim() });
      current = { title: heading[1]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ title: current.title, body: current.lines.join('\n').trim() });
  return out;
}

/** The clinic's note templates: add, edit, switch off, import, and copy a starter to make it the clinic's own. No patient data. */
export function TemplateManager({ backend, onClose, heading = 'Note templates' }: { backend: AppBackend; onClose?: () => void; heading?: string }) {
  const [templates, setTemplates] = useState<NoteTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  useEffect(() => {
    backend
      .listNoteTemplates(true)
      .then((r) => setTemplates(r.templates))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The templates could not be loaded.'));
  }, [backend]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const r = await backend.saveNoteTemplate(draft);
      setTemplates(r.templates);
      setSaved(`${draft.title.trim()} saved.`);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    const items = parseTemplateImport(importText);
    if (items.length === 0) {
      setError('No templates found. Start each one with a line like "## Examination".');
      return;
    }
    const bad = items.map((t) => ({ t, c: checkTemplate(t.title, t.body) })).filter((x) => !x.c.ok);
    if (bad.length) {
      const first = bad[0]!;
      setError(`"${first.t.title}": ${first.c.ok ? '' : first.c.message} Nothing was imported.`);
      return;
    }
    // Running the same import twice must not make duplicates: templates whose name is already in use are skipped.
    const taken = new Set((templates ?? []).filter((t) => !t.starter && t.active).map((t) => t.title.toLowerCase()));
    const fresh = items.filter((t) => !taken.has(t.title.trim().replace(/\s+/g, ' ').toLowerCase()));
    const skipped = items.length - fresh.length;
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const t of fresh) {
        const r = await backend.saveNoteTemplate({ templateId: null, title: t.title, body: t.body, active: true });
        setTemplates(r.templates);
        done += 1;
      }
      setSaved(`${done} template${done === 1 ? '' : 's'} imported.${skipped ? ` ${skipped} skipped because a template with that name already exists.` : ''}`);
      setImporting(false);
      setImportText('');
    } catch (err) {
      setError(`${done} of ${fresh.length} imported, then: ${err instanceof Error ? err.message : 'that did not save'}`);
    } finally {
      setBusy(false);
    }
  }

  const own = (templates ?? []).filter((t) => !t.starter);
  const starters = (templates ?? []).filter((t) => t.starter);
  const fields = draft ? templateFields(draft.body) : [];

  return (
    <section className="note-writer" aria-labelledby="templates-heading">
      <div className="state-heading">
        <h2 id="templates-heading">{heading}</h2>
        {onClose && (
          <button type="button" className="link-button" onClick={onClose}>
            Back to the note
          </button>
        )}
      </div>
      {error && <Notice tone="bad" title={error} />}
      {saved && <Notice tone="info" title={saved} />}

      {draft ? (
        <div className="admin-form">
          <h3>{draft.templateId ? 'Edit template' : 'New template'}</h3>
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Text</span>
            <textarea className="note-text" rows={14} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          <p className="state-lead">
            Put blanks in square brackets, like <code>[Tooth]</code>. For a choice, list the options after a colon, separated by slashes:{' '}
            <code>[Consent: verbal / written]</code>. Write teeth as UR1, LL6.
          </p>
          {fields.length > 0 && <p className="admin-sub">Blanks: {fields.map((f) => (f.options.length ? `${f.label} (${f.options.join(', ')})` : f.label)).join('; ')}</p>}
          <label className="admin-check">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            <span>In use</span>
          </label>
          <div className="actions">
            <button type="button" className="button button-primary" disabled={busy || !draft.title.trim() || !draft.body.trim()} onClick={() => void save()}>
              Save template
            </button>
            <button type="button" className="button button-quiet" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setDraft({ templateId: null, title: '', body: '', active: true })}>
              New template
            </button>
            <button type="button" className="button button-quiet" onClick={() => setImporting((v) => !v)}>
              Import templates
            </button>
          </div>
          {importing && (
            <div className="admin-form">
              <h3>Import templates</h3>
              <p className="state-lead">
                Dentally does not let other apps read its note templates, so copy them across: open each template in Dentally, copy its text,
                and paste it here under a line starting with <code>##</code> and the template's name. Paste as many as you like, then import.
              </p>
              <textarea
                className="note-text"
                rows={12}
                aria-label="Templates to import"
                placeholder={'## Examination\nC/O: [Complaint]\n...\n\n## Composite restoration\n...'}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <p className="admin-sub">
                {((n) => (n ? `${n} template${n === 1 ? '' : 's'} found.` : 'No templates found yet.'))(parseTemplateImport(importText).length)} Turn blanks into
                boxes by putting them in square brackets, like [Tooth].
              </p>
              <div className="actions">
                <button type="button" className="button button-primary" disabled={busy || !importText.trim()} onClick={() => void runImport()}>
                  Import
                </button>
              </div>
            </div>
          )}
          <h3>Your templates</h3>
          {own.length === 0 ? (
            <p className="state-lead">None yet. Make a new one, or copy a starter below and change it.</p>
          ) : (
            <ul className="admin-list">
              {own.map((t) => (
                <li key={t.templateId} className={`admin-row ${t.active ? '' : 'is-muted'}`}>
                  <span>
                    <strong>{t.title}</strong>
                    {t.active ? '' : <span className="admin-sub"> not in use</span>}
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setDraft({ templateId: t.templateId, title: t.title, body: t.body, active: t.active })}
                  >
                    Edit {t.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3>Starter templates</h3>
          <p className="state-lead">General wording to start from. Copy one to make it your own.</p>
          <ul className="admin-list">
            {starters.map((t) => (
              <li key={t.templateId} className="admin-row">
                <strong>{t.title}</strong>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setDraft({ templateId: null, title: t.title.replace(/\s*\(starter\)$/, ''), body: t.body, active: true })}
                >
                  Copy {t.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
