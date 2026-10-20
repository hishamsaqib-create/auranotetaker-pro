import { useEffect, useState } from 'react';
import type { NoteTemplate } from '../../lib/core/noteTemplates.ts';
import { templateFields } from '../../lib/core/noteTemplates.ts';
import type { AppBackend } from '../backend/types.ts';
import { Notice } from './Notice.tsx';

interface Draft {
  templateId: string | null;
  title: string;
  body: string;
  active: boolean;
}

/** The clinic's note templates: add, edit, switch off, and copy a starter to make it the clinic's own. No patient data. */
export function TemplateManager({ backend, onClose }: { backend: AppBackend; onClose: () => void }) {
  const [templates, setTemplates] = useState<NoteTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const own = (templates ?? []).filter((t) => !t.starter);
  const starters = (templates ?? []).filter((t) => t.starter);
  const fields = draft ? templateFields(draft.body) : [];

  return (
    <section className="note-writer" aria-labelledby="templates-heading">
      <div className="state-heading">
        <h2 id="templates-heading">Note templates</h2>
        <button type="button" className="link-button" onClick={onClose}>
          Back to the note
        </button>
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
          </div>
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
