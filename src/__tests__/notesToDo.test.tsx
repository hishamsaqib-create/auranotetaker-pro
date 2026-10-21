// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_PRACTITIONERS } from '../../lib/dentally/mock.ts';
import { createDemoBackend } from '../backend/demoBackend.ts';
import { NotesToDo } from '../components/NotesToDo.tsx';
import { NoteWriter } from '../components/NoteWriter.tsx';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
afterEach(cleanup);

describe('notes to do', () => {
  it('lists finished appointments with no note and ticks one off as written in Dentally', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    backend.demo!.signInAs('sarah.lin@demo.invalid');
    const user = userEvent.setup();
    const clinicians = DEMO_PRACTITIONERS.map((p) => ({ practitionerId: p.practitionerId, displayName: p.displayName, clinicianType: 'DENTIST' as const }));
    render(<NotesToDo backend={backend} clinicians={clinicians} initialPractitionerId="DEMO-PR1" timeZone="Europe/London" canMark onClose={() => undefined} />);
    expect(await screen.findByText('Grace Whitfield')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Written in Dentally' });
    expect(buttons).toHaveLength(3);
    await user.click(buttons[0]!);
    expect(await screen.findByText(/Ticked off as written in Dentally/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Written in Dentally' })).toHaveLength(2));
  });
});

describe('note check', () => {
  it('checks a standalone note on this computer and points out a contradiction', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    backend.demo!.signInAs('sarah.lin@demo.invalid');
    render(<NoteWriter backend={backend} patientLabel={null} sessionId={null} canManageTemplates={false} copyText={async () => undefined} />);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'LA: none.\n1 cartridge articaine IDB.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check for contradictions' }));
    expect(await screen.findByText('1 point to look at again')).toBeInTheDocument();
    expect(screen.getByText(/Says no local anaesthetic was used/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'LA: none. Scale and polish.' } });
    expect(screen.getByText(/The note has changed since it was checked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for contradictions' }));
    expect(await screen.findByText('No contradictions found')).toBeInTheDocument();
    expect(screen.getByText(/does not replace your own check/)).toBeInTheDocument();
  });
});
