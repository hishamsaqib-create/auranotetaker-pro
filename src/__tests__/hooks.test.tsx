// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { toDiaryDto } from '../../lib/core/appointments.ts';
import type { DiaryResponse, PatientSummaryResponse } from '../../lib/server/handlers.ts';
import type { AppBackend } from '../backend/types.ts';
import { PatientCard } from '../components/PatientCard.tsx';
import { useChangeGuard } from '../hooks/useChangeGuard.ts';
import { useDiary } from '../hooks/useDiary.ts';
import { summaryKey, usePatientSummaries } from '../hooks/usePatientSummaries.ts';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const MIN = 60_000;
// Clocks are passed to useDiary as dependencies, so they must keep one identity across renders.
const serverClock = () => NOW;
const fastClock = () => NOW + 7 * MIN;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function appointment(appointmentId: string, patientId: string, patientName: string): DiaryAppointment {
  return {
    appointmentId,
    patientId,
    patientName,
    practitionerId: 'PR1',
    roomId: 'R1',
    startMs: NOW - 15 * MIN,
    finishMs: NOW + 30 * MIN,
    state: 'In surgery',
    rawState: null,
    reason: 'Review',
    inSurgeryAtMs: NOW - 15 * MIN,
    arrivedAtMs: null,
    completedAtMs: null,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function diaryResponse(appointments: DiaryAppointment[], fetchedAtMs = NOW): DiaryResponse {
  return {
    date: '2026-10-20',
    timeZone: 'Europe/London',
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    practitionerId: 'PR1',
    appointments: appointments.map(toDiaryDto),
    rejectedCount: 0,
    scribeOutcomes: {},
    predictionOptions: { earlyStartMinutes: 10, overrunMinutes: 30 },
  };
}

describe('useChangeGuard', () => {
  it('holds after every change, including a quick change away and back', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ k }) => useChangeGuard(k, 1500), { initialProps: { k: 'A' } });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe(true);

    rerender({ k: 'B' });
    expect(result.current).toBe(false); // false in the very render where the key changes
    act(() => vi.advanceTimersByTime(500));
    rerender({ k: 'A' });
    expect(result.current).toBe(false); // back to A does not re-enable A at once
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });
});

describe('usePatientSummaries', () => {
  it('never shows a patient other than the one the diary shows for that appointment', async () => {
    const getPatientSummary = vi.fn(
      async (appointmentId: string): Promise<PatientSummaryResponse> => ({
        appointmentId,
        patientId: 'P2', // Dentally has re-booked the appointment since the diary was read
        displayName: 'Someone Else',
        dateOfBirth: '1990-01-01',
      }),
    );
    const backend = { getPatientSummary } as unknown as AppBackend;
    const request = { appointmentId: 'A1', patientId: 'P1' };
    const { result } = renderHook(() => usePatientSummaries(backend, [request]));
    await waitFor(() => expect(result.current.get(summaryKey(request))?.status).toBe('mismatch'));
  });

  it('keys details by appointment and patient, so a re-booked appointment is looked up afresh', async () => {
    const names: Record<string, string> = { P1: 'Oliver Bennett', P2: 'Priya Raman' };
    let current = 'P1';
    const getPatientSummary = vi.fn(
      async (appointmentId: string): Promise<PatientSummaryResponse> => ({ appointmentId, patientId: current, displayName: names[current]!, dateOfBirth: null }),
    );
    const backend = { getPatientSummary } as unknown as AppBackend;
    const { result, rerender } = renderHook(({ patientId }) => usePatientSummaries(backend, [{ appointmentId: 'A1', patientId }]), {
      initialProps: { patientId: 'P1' },
    });
    await waitFor(() => expect(result.current.get('A1:P1')).toMatchObject({ status: 'ok', data: { displayName: 'Oliver Bennett' } }));
    current = 'P2';
    rerender({ patientId: 'P2' });
    await waitFor(() => expect(result.current.get('A1:P2')).toMatchObject({ status: 'ok', data: { displayName: 'Priya Raman' } }));
    expect(getPatientSummary).toHaveBeenCalledTimes(2);
  });
});

describe('useDiary', () => {
  it('ignores an older response that arrives after a newer one', async () => {
    const calls = [deferred<DiaryResponse>(), deferred<DiaryResponse>()];
    let n = 0;
    const backend = { getDiary: vi.fn(() => calls[n++]!.promise) } as unknown as AppBackend;
    const { result } = renderHook(() => useDiary(backend, 'PR1', serverClock));
    await waitFor(() => expect(backend.getDiary).toHaveBeenCalledTimes(1));

    act(() => void result.current.refresh());
    await act(async () => calls[1]!.resolve(diaryResponse([appointment('A2', 'P2', 'Newer Diary')])));
    await act(async () => calls[0]!.resolve(diaryResponse([appointment('A1', 'P1', 'Older Diary')])));

    expect(result.current.appointments.map((a) => a.patientName)).toEqual(['Newer Diary']);
  });

  it("measures how far this computer's clock is from the server's", async () => {
    const backend = { getDiary: vi.fn(async () => diaryResponse([], NOW)) } as unknown as AppBackend;
    const { result } = renderHook(() => useDiary(backend, 'PR1', fastClock));
    await waitFor(() => expect(result.current.clockOffsetMs).toBe(-7 * MIN));
  });
});

describe('PatientCard', () => {
  const props = {
    appointment: appointment('A1', 'P1', 'Oliver Bennett'),
    timeZone: 'Europe/London',
    clinicianName: 'Dr Sarah Lin',
    roomNames: { R1: 'Surgery 1' },
    ready: true,
    busy: false,
    onConfirm: () => undefined,
  };

  it('cannot be confirmed while the patient details are still loading', () => {
    render(<PatientCard {...props} summary={{ status: 'loading' }} />);
    expect(screen.getByRole('button', { name: 'Confirm Oliver Bennett' })).toBeDisabled();
    expect(screen.getByText("Confirm becomes available once Dentally has returned the patient's details.")).toBeInTheDocument();
  });

  it('cannot be confirmed when Dentally returns a different patient for the appointment', () => {
    render(<PatientCard {...props} summary={{ status: 'mismatch' }} onRetry={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Confirm Oliver Bennett' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Dentally now shows a different patient for this appointment');
    expect(screen.getByRole('button', { name: 'Refresh the diary' })).toBeInTheDocument();
  });

  it('can be confirmed once Dentally confirms the same patient', () => {
    render(
      <PatientCard
        {...props}
        summary={{ status: 'ok', data: { appointmentId: 'A1', patientId: 'P1', displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' } }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm Oliver Bennett' })).toBeEnabled();
    expect(screen.getByText('12 Mar 1986')).toBeInTheDocument();
  });
});
