// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DemoScenario } from '../../lib/dentally/mock.ts';
import { App } from '../App.tsx';
import { createDemoBackend } from '../backend/demoBackend.ts';
import { BackendError } from '../backend/types.ts';

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

  it('caps confidence and says which appointment may still be running when the previous one was never completed', async () => {
    const { user } = setup('previous-open');
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Likely current patient' })).toBeInTheDocument();
    expect(screen.getByText('Medium confidence: check the reasons')).toBeInTheDocument();
    expect(
      screen.getByText('The 09:45–10:30 appointment is not marked completed in Dentally and may still be running. Check who is in the chair.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Patient Oliver Bennett' })).toBeInTheDocument();
  });

  it('shows the new patient when Dentally re-books the appointment, and holds confirm until their details are checked', async () => {
    const { user, backend } = setup();
    await signIn(user);
    const oliver = await screen.findByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(oliver).toBeEnabled(), { timeout: 3000 });

    backend.demo!.rebook('DEMO-A04', 'DEMO-P1009');
    await user.click(screen.getByRole('button', { name: /^Updated/ }));

    const priya = await screen.findByRole('button', { name: 'Confirm Priya Raman' });
    expect(priya).toBeDisabled();
    expect(screen.queryByRole('article', { name: 'Patient Oliver Bennett' })).not.toBeInTheDocument();
    expect(await within(screen.getByRole('article', { name: 'Patient Priya Raman' })).findByText('27 Feb 1997')).toBeInTheDocument();
    await waitFor(() => expect(priya).toBeEnabled(), { timeout: 3000 });
    await user.click(priya);
    const locked = await screen.findByLabelText('Patient locked to this session');
    expect(locked).toHaveTextContent('Priya Raman');
    expect(locked).toHaveTextContent('DEMO-P1009');
  });

  it('refuses to lock a patient Dentally has re-booked since the diary was read, and shows the new booking', async () => {
    const { user, backend } = setup();
    await signIn(user);
    const oliver = await screen.findByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(oliver).toBeEnabled(), { timeout: 3000 });

    backend.demo!.rebook('DEMO-A04', 'DEMO-P1009');
    await user.click(oliver);

    expect(await screen.findByText(/In Dentally this appointment is no longer booked for that patient/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Confirm Priya Raman' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Patient locked to this session')).not.toBeInTheDocument();
    expect(backend.demo!.auditEvents().some((e) => e.action === 'PATIENT_CONFIRMED')).toBe(false);
  });

  it('asks before confirming again a patient who declined the scribe earlier in the appointment', async () => {
    const { user, backend } = setup();
    await signIn(user);
    const confirm = await screen.findByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 3000 });
    await user.click(confirm);
    await user.click(await screen.findByRole('button', { name: 'No, Oliver declined' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));

    const diary = await screen.findByRole('list', { name: 'Appointments today with Dr Sarah Lin' });
    await user.click(within(diary).getByRole('button', { name: /Oliver Bennett/ }));
    const again = screen.getByRole('button', { name: 'Confirm Oliver Bennett' });
    await waitFor(() => expect(again).toBeEnabled(), { timeout: 3000 });
    await user.click(again);

    expect(await screen.findByText(/declined the AI scribe for this appointment earlier/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Patient locked to this session')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'The patient has changed their mind' }));
    expect(await screen.findByLabelText('Patient locked to this session')).toHaveTextContent('Oliver Bennett');
    const confirmations = backend.demo!.auditEvents().filter((e) => e.action === 'PATIENT_CONFIRMED');
    expect(confirmations.at(-1)?.details.acknowledgedPreviousDecline).toBe(true);
  });

  it('offers only Cancel for a session that is open in another surgery', async () => {
    localStorage.setItem('auranotetaker.device-setup.v1', JSON.stringify({ practitionerId: 'DEMO-PR1', surgeryId: 'DEMO-SURGERY-1' }));
    const backend = createDemoBackend({ clock, latencyMs: 0 });
    // Dr Lin's session was started in Surgery 2 earlier; this computer is in Surgery 1.
    backend.demo!.signInAs('sarah.lin@demo.invalid');
    await backend.confirmPatient({
      appointmentId: 'DEMO-A04',
      patientId: 'DEMO-P1001',
      practitionerId: 'DEMO-PR1',
      surgeryId: 'DEMO-SURGERY-2',
      predictedAppointmentId: null,
      method: 'CHOSE_FROM_DIARY',
    });
    await backend.signOut();
    const user = userEvent.setup();
    render(<App backend={backend} clock={clock} />);
    await signIn(user);

    expect(await screen.findByRole('heading', { name: 'This session is open in Surgery 2' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Patient locked to this session')).toHaveTextContent('Oliver Bennett');
    expect(screen.queryByRole('button', { name: /agreed/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel this session' }));
    expect(await screen.findByRole('heading', { name: 'Likely current patient' })).toBeInTheDocument();
  });

  it("uses the server's time when this computer's clock is wrong, and says so", async () => {
    localStorage.setItem('auranotetaker.device-setup.v1', JSON.stringify({ practitionerId: 'DEMO-PR1', surgeryId: 'DEMO-SURGERY-1' }));
    const backend = createDemoBackend({ clock, latencyMs: 0 });
    const user = userEvent.setup();
    // 40 minutes fast: by this computer's clock Oliver's appointment is over and the next one has started.
    render(<App backend={backend} clock={() => NOW + 40 * 60_000} />);
    await signIn(user);

    expect(await screen.findByText("This computer's clock is 40 minutes fast")).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Likely current patient' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Patient Oliver Bennett' })).toBeInTheDocument();
    expect(screen.getByLabelText('Time now 10:40')).toBeInTheDocument();
  });

  it('says so when it cannot check for an open session, instead of carrying on silently', async () => {
    localStorage.setItem('auranotetaker.device-setup.v1', JSON.stringify({ practitionerId: 'DEMO-PR1', surgeryId: 'DEMO-SURGERY-1' }));
    const demo = createDemoBackend({ clock, latencyMs: 0 });
    const backend = {
      ...demo,
      getActiveSession: async () => {
        throw new BackendError('INTERNAL', 'The change was saved but could not be added to the audit trail. Please tell the practice manager.');
      },
    };
    const user = userEvent.setup();
    render(<App backend={backend} clock={clock} />);
    await signIn(user);
    expect(await screen.findByText('Could not check for an open session in this surgery')).toBeInTheDocument();
    expect(screen.getByText(/could not be added to the audit trail/)).toBeInTheDocument();
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
