// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DemoScenario } from '../../lib/dentally/mock.ts';
import { App } from '../App.tsx';
import { createDemoBackend } from '../backend/demoBackend.ts';

// Fixed clock: 10:40 on 20 October 2026. The fictional diary is anchored to it.
const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const clock = () => NOW;

function setup(scenario: DemoScenario = 'normal', { preset = true } = {}) {
  if (preset) {
    localStorage.setItem('auranotetaker.device-setup.v1', JSON.stringify({ practitionerId: 'DEMO-PR1', surgeryId: 'DEMO-SURGERY-1' }));
  }
  const backend = createDemoBackend({ clock, scenario, latencyMs: 0 });
  const user = userEvent.setup();
  render(<App backend={backend} clock={clock} />);
  return { backend, user };
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Dr Sarah Lin/ }));
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('AuraNoteTaker main clinical screen (demo mode)', () => {
  it('requires sign-in, then asks which clinician and surgery this computer is for', async () => {
    const { user } = setup('normal', { preset: false });
    expect(await screen.findByRole('heading', { name: 'Sign in to the demo' })).toBeInTheDocument();
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Who is this computer working with?' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Dr Sarah Lin/ }));
    await user.click(screen.getByRole('radio', { name: /Surgery 1/ }));
    await user.click(screen.getByRole('button', { name: 'Use this computer for Dr Sarah Lin in Surgery 1' }));
    expect(await screen.findByRole('heading', { name: 'Likely current patient' })).toBeInTheDocument();
  });

  it('shows a permanent demo banner so fictional data cannot be mistaken for a live diary', async () => {
    const { user } = setup();
    await signIn(user);
    expect(await screen.findByLabelText('Demo mode')).toHaveTextContent('Patients are fictional and nothing is connected to Dentally');
  });

  it('explains the suggestion, names the patient on the confirm button and holds it briefly before enabling', async () => {
    const { user } = setup();
    await signIn(user);
    const card = await screen.findByRole('article', { name: 'Patient Oliver Bennett' });
    expect(within(card).getByText('Appointment scheduled 10:25–11:10 with Dr Sarah Lin')).toBeInTheDocument();
    expect(within(card).getByText('Dentally shows this patient as In surgery')).toBeInTheDocument();
    expect(await within(card).findByText('12 Mar 1986')).toBeInTheDocument();
    expect(screen.getByText('High confidence')).toBeInTheDocument();

    const confirm = within(card).getByRole('button', { name: 'Confirm Oliver Bennett' });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 3000 });
  });

  it('locks the confirmed patient to the session and records the confirmation in the audit trail', async () => {
    const { user, backend } = setup();
    await signIn(user);
    const confirm = await screen.findByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 3000 });
    await user.click(confirm);

    const locked = await screen.findByLabelText('Patient locked to this session');
    expect(locked).toHaveTextContent('Oliver Bennett');
    expect(locked).toHaveTextContent('DEMO-P1001');
    expect(screen.getByRole('heading', { name: 'Has Oliver agreed to the AI scribe for this appointment?' })).toBeInTheDocument();
    // The clinician and surgery cannot be changed under a locked patient.
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();

    const confirmed = backend.demo!.auditEvents().find((e) => e.action === 'PATIENT_CONFIRMED');
    expect(confirmed).toMatchObject({ dentallyPatientId: 'DEMO-P1001', details: { method: 'CONFIRMED_SUGGESTION', matchedPrediction: true } });
  });

  it('offers no default when two patients are booked at the same time', async () => {
    const { user } = setup('double-booked');
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Check who is in the chair' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Likely current patient' })).not.toBeInTheDocument();
    expect(screen.getByText(/Two appointments for this clinician overlap now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Oliver Bennett' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Priya Raman' })).toBeInTheDocument();
    expect(screen.queryByText('High confidence')).not.toBeInTheDocument();
  });

  it('records choosing between ambiguous patients as resolving an ambiguity', async () => {
    const { user, backend } = setup('double-booked');
    await signIn(user);
    const confirm = await screen.findByRole('button', { name: 'Confirm Priya Raman' });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 3000 });
    await user.click(confirm);
    await screen.findByLabelText('Patient locked to this session');
    expect(backend.demo!.auditEvents().find((e) => e.action === 'PATIENT_CONFIRMED')?.details).toMatchObject({
      method: 'RESOLVED_AMBIGUITY',
      predictedAppointmentId: null,
    });
  });

  it('when the patient declines, ends the session with no AI processing and moves on to the next appointment', async () => {
    const { user } = setup();
    await signIn(user);
    const confirm = await screen.findByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 3000 });
    await user.click(confirm);
    await user.click(await screen.findByRole('button', { name: 'No, Oliver declined' }));
    expect(await screen.findByRole('heading', { name: 'Scribe off for this appointment' })).toBeInTheDocument();
    expect(screen.getByText(/nothing about this appointment will be sent for AI processing/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // Oliver is not suggested again; the next appointment is offered instead.
    expect(await screen.findByRole('heading', { name: 'No appointment for Dr Sarah Lin right now' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Confirm Amara Nwosu' })).toBeInTheDocument();
  });

  it('requires a confirm card for a patient chosen from the diary (no one-click confirm from the list)', async () => {
    const { user } = setup();
    await signIn(user);
    const diary = await screen.findByRole('list', { name: 'Appointments today with Dr Sarah Lin' });
    await user.click(within(diary).getByRole('button', { name: /Amara Nwosu/ }));
    expect(screen.getByRole('heading', { name: "Chosen from today's diary" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Amara Nwosu' })).toBeDisabled();
    expect(screen.getByRole('article', { name: 'Patient Amara Nwosu' })).toBeInTheDocument();
  });

  it('does not let cancelled or patient-less diary entries be chosen', async () => {
    const { user } = setup();
    await signIn(user);
    const diary = await screen.findByRole('list', { name: 'Appointments today with Dr Sarah Lin' });
    expect(within(diary).queryByRole('button', { name: /Marcus Hale/ })).not.toBeInTheDocument();
    expect(within(diary).getByText('Marcus Hale')).toBeInTheDocument();
    expect(within(diary).queryByRole('button', { name: /No patient/ })).not.toBeInTheDocument();
  });

  it('blocks new sessions while Dentally is unavailable, and says why', async () => {
    const { user } = setup('dentally-offline');
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Dentally is not responding' })).toBeInTheDocument();
    expect(screen.getByText(/because the patient cannot be checked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm/ })).not.toBeInTheDocument();
    expect(screen.getByText('Dentally offline')).toBeInTheDocument();
  });
});
