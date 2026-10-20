// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoBackend } from '../backend/demoBackend.ts';
import { NoteWriter } from '../components/NoteWriter.tsx';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
afterEach(cleanup);

function setup(patientLabel: string | null = 'Oliver Bennett, born 12 Mar 1986', manage = true) {
  const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
  backend.demo!.signInAs(manage ? 'jo.morgan@demo.invalid' : 'sarah.lin@demo.invalid');
  const copies: string[] = [];
  const user = userEvent.setup();
  render(<NoteWriter backend={backend} patientLabel={patientLabel} sessionId={null} canManageTemplates={manage} copyText={async (t) => void copies.push(t)} />);
  return { backend, copies, user };
}

describe('note writer', () => {
  it('fills a template, warns about blanks left, and copies the note naming the patient', async () => {
    const { backend, copies, user } = setup(undefined, false);
    const pick = screen.getByLabelText('Template');
    await waitFor(() => expect(pick).toBeEnabled());
    await user.selectOptions(pick, 'starter-extraction');
    await user.type(screen.getByLabelText('Tooth'), 'LR8');
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(note.value).toContain('Extraction LR8');
    expect(screen.getByText(/Still to fill in: .*Consent/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy for Dentally' }));
    expect(copies[0]).toContain('Extraction LR8');
    expect(await screen.findByText(/^Copied with \d+ blanks still in brackets \(Medical history, Consent, .*Paste it into the notes for Oliver Bennett, born 12 Mar 1986 in Dentally\.$/)).toBeInTheDocument();
    const audit = backend.demo!.auditEvents().at(-1)!;
    expect(audit).toMatchObject({ action: 'NOTE_COPIED', details: { templateId: 'starter-extraction', source: 'STANDALONE' } });
    expect(JSON.stringify(audit)).not.toContain('LR8');
  });

  it('lets the note be written by hand, and says when no patient is selected', async () => {
    const { copies, user } = setup(null, false);
    expect(screen.queryByRole('button', { name: 'Manage templates' })).not.toBeInTheDocument();
    expect(screen.getByText('No patient selected')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Note'), 'Reviewed [[Tooth], no change.');
    expect(screen.getByText('Still to fill in: Tooth')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Note'));
    await user.type(screen.getByLabelText('Note'), 'Reviewed, no change.');
    await user.click(screen.getByRole('button', { name: 'Copy for Dentally' }));
    expect(copies).toEqual(['Reviewed, no change.']);
    expect(await screen.findByText("Copied. Paste it into the right patient's notes in Dentally.")).toBeInTheDocument();
  });

  it('stops filling from the boxes once edited by hand, until rebuilt', async () => {
    const { user } = setup(undefined, false);
    const pick = screen.getByLabelText('Template');
    await waitFor(() => expect(pick).toBeEnabled());
    await user.selectOptions(pick, 'starter-hygiene');
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    await user.type(note, ' Extra.');
    await user.type(screen.getByLabelText('BPE'), '111/111');
    expect(note.value).not.toContain('111/111');
    await user.click(screen.getByRole('button', { name: 'Rebuild it from the boxes' }));
    expect(note.value).toContain('BPE: 111/111');
  });

  it('makes a clinic template from a starter', async () => {
    const { backend, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Manage templates' }));
    await user.click(await screen.findByRole('button', { name: 'Copy Composite restoration (starter)' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Composite restoration');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Composite restoration saved.')).toBeInTheDocument();
    const own = (await backend.listNoteTemplates()).templates.filter((t) => !t.starter);
    expect(own.map((t) => t.title)).toEqual(['Composite restoration']);
  });
});

describe('templates import', () => {
  it('splits pasted templates on ## headings', async () => {
    const { parseTemplateImport } = await import('../components/TemplateManager.tsx');
    expect(parseTemplateImport('## Exam\nC/O: [Complaint]\n### Findings\nNAD\n\n## Filling\n[Tooth]\n')).toEqual([
      { title: 'Exam', body: 'C/O: [Complaint]\n### Findings\nNAD' },
      { title: 'Filling', body: '[Tooth]' },
    ]);
    expect(parseTemplateImport('no headings here')).toEqual([]);
  });
});

describe('generate note in the writer', () => {
  it('replaces the note with an AI draft that must be ticked as checked before copying, and can be undone', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    backend.demo!.signInAs('sarah.lin@demo.invalid');
    const copies: string[] = [];
    const sent: { templateId: string | null; notes: string }[] = [];
    const user = userEvent.setup();
    render(
      <NoteWriter
        backend={backend}
        patientLabel="Oliver Bennett, born 12 Mar 1986"
        sessionId={null}
        canManageTemplates={false}
        copyText={async (t) => void copies.push(t)}
        generate={async (templateId, notes) => {
          sent.push({ templateId, notes });
          return { draft: 'Extraction LR8. [Consent]', provider: 'DEMO', model: 'demo' };
        }}
      />,
    );
    await user.type(screen.getByLabelText('Note'), 'LR8 out, anxious');
    await user.click(screen.getByRole('button', { name: 'Generate note' }));
    expect(sent).toEqual([{ templateId: null, notes: 'LR8 out, anxious' }]);
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(note.value).toBe('Extraction LR8. [Consent]');
    expect(screen.getByText('AI draft: check every line against what happened before copying')).toBeInTheDocument();
    const copy = screen.getByRole('button', { name: 'Copy for Dentally' });
    expect(copy).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I have checked every line of this draft' }));
    await user.click(copy);
    expect(copies).toEqual(['Extraction LR8. [Consent]']);
    expect(backend.demo!.auditEvents().at(-1)).toMatchObject({ action: 'NOTE_COPIED', details: { aiDraft: true, unfilledCount: 1 } });
    // A second draft, undone, brings back the first draft still marked as AI, still needing the tick.
    await user.click(screen.getByRole('button', { name: 'Generate note' }));
    await user.click(screen.getByRole('button', { name: 'Undo the draft' }));
    expect(note.value).toBe('Extraction LR8. [Consent]');
    expect(screen.getByRole('button', { name: 'Copy for Dentally' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'I have checked every line of this draft' })).not.toBeChecked();
  });

  it('explains when AI drafting is not allowed', () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    render(<NoteWriter backend={backend} patientLabel={null} sessionId={null} canManageTemplates={false} generateUnavailable="The patient did not agree to the AI scribe." />);
    expect(screen.queryByRole('button', { name: 'Generate note' })).not.toBeInTheDocument();
    expect(screen.getByText('The patient did not agree to the AI scribe.')).toBeInTheDocument();
  });
});
