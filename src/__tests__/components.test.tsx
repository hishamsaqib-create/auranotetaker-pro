// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import type { ScribeSession } from '../../lib/core/session.ts';
import { createSession } from '../../lib/core/session.ts';
import type { AppBackend } from '../backend/types.ts';
import { DiaryList } from '../components/DiaryList.tsx';
import { SessionPanel } from '../components/SessionPanel.tsx';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const MIN = 60_000;

afterEach(cleanup);

function appointment(appointmentId: string, patientId: string, patientName: string): DiaryAppointment {
  return {
    appointmentId,
    patientId,
    patientName,
    practitionerId: 'PR1',
    roomId: 'R1',
    startMs: NOW - 15 * MIN,
    finishMs: NOW + 30 * MIN,
    state: 'Arrived',
    rawState: null,
    reason: 'Review',
    inSurgeryAtMs: null,
    arrivedAtMs: null,
    completedAtMs: null,
  };
}

describe('DiaryList', () => {
  const common = {
    clinicianName: 'Dr Sarah Lin',
    timeZone: 'Europe/London',
    roomNames: { R1: 'Surgery 1' },
    currentIds: new Set<string>(),
    outcomes: {},
    selectedId: null,
    onSelect: () => undefined,
    loading: false,
    lastOkAt: NOW,
    rejectedCount: 0,
    onRefresh: () => undefined,
  };

  it('shows two different bookings under one appointment ID, but lets neither be chosen', () => {
    const real = appointment('A1', 'P1', 'Oliver Bennett');
    const clash = { ...real, patientId: 'P2', patientName: 'Priya Raman' };
    render(<DiaryList {...common} appointments={[real, clash]} conflictingIds={new Set(['A1'])} />);
    const list = screen.getByRole('list', { name: 'Appointments today with Dr Sarah Lin' });
    expect(within(list).getByText('Oliver Bennett')).toBeInTheDocument();
    expect(within(list).getByText('Priya Raman')).toBeInTheDocument();
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).getAllByText('Check in Dentally')).toHaveLength(2);
  });

  it('shows an exact repeat of an entry once', () => {
    const entry = appointment('A1', 'P1', 'Oliver Bennett');
    render(<DiaryList {...common} appointments={[entry, { ...entry }]} conflictingIds={new Set()} />);
    expect(screen.getAllByRole('button', { name: /Oliver Bennett/ })).toHaveLength(1);
  });
});

describe('SessionPanel', () => {
  function sessionIn(status: ScribeSession['status']): ScribeSession {
    const s = createSession({
      sessionId: 'S1',
      clinicId: 'C1',
      clinicianId: 'PR1',
      surgeryId: 'SURGERY-2',
      patient: {
        dentallyPatientId: 'P1',
        appointment: { appointmentId: 'A1', practitionerId: 'PR1', roomId: 'R2', startMs: NOW - 15 * MIN, finishMs: NOW + 30 * MIN, reason: 'Review', stateAtConfirmation: 'Arrived' },
      },
      method: 'CHOSE_FROM_DIARY',
      predictedAppointmentId: null,
      confirmedBy: 'nurse@aura.test',
      atMs: NOW,
    });
    return { ...s, status };
  }

  const backend = { getSessionPatient: async () => ({ patientId: 'P1', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' }) } as unknown as AppBackend;
  const props = {
    backend,
    patient: null,
    currentSurgeryId: 'SURGERY-1',
    timeZone: 'Europe/London',
    clinicianName: 'Dr Sarah Lin',
    surgeryName: 'Surgery 2',
    onSessionChange: () => undefined,
    onClose: () => undefined,
    onReload: () => undefined,
  };

  it('offers only Cancel for a session open in another surgery, and shows the appointment date', async () => {
    render(<SessionPanel {...props} session={sessionIn('PATIENT_CONFIRMED')} restriction="OTHER_SURGERY" />);
    expect(screen.getByRole('heading', { name: 'This session is open in Surgery 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel this session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /agreed|declined/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/20 Oct 2026/)).toBeInTheDocument();
  });

  it('does not offer Cancel for a session that already has a recording', () => {
    render(<SessionPanel {...props} session={sessionIn('RECORDING')} restriction="OTHER_SURGERY" />);
    expect(screen.queryByRole('button', { name: 'Cancel this session' })).not.toBeInTheDocument();
    expect(screen.getByText(/already has a recording, so it cannot be cancelled here/)).toBeInTheDocument();
  });
});
