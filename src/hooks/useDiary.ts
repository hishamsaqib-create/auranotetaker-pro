import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { fromDiaryDto } from '../../lib/core/appointments.ts';
import type { AppBackend, DiaryReason } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';

export const VISIBLE_REFRESH_MS = 60_000;
export const HIDDEN_REFRESH_MS = 5 * 60_000;
export const STALE_AFTER_MS = 2 * 60_000;

export interface DiaryState {
  practitionerId: string | null;
  appointments: DiaryAppointment[];
  timeZone: string | null;
  rejectedCount: number;
  loading: boolean;
  error: BackendError | null;
  /** Time of the last successful fetch. */
  lastOkAt: number | null;
}

const empty = (practitionerId: string | null): DiaryState => ({
  practitionerId,
  appointments: [],
  timeZone: null,
  rejectedCount: 0,
  loading: practitionerId !== null,
  error: null,
  lastOkAt: null,
});

/**
 * Today's diary for one clinician, refreshed every minute while visible and every five while hidden.
 * Switching clinician clears the previous clinician's diary immediately, and responses that arrive
 * for a clinician no longer selected are discarded, so one clinician's patients never show under another.
 */
export function useDiary(backend: AppBackend, practitionerId: string | null, clock: () => number = Date.now) {
  const [state, setState] = useState<DiaryState>(() => empty(practitionerId));
  const current = useRef(practitionerId);
  const lastFetchAt = useRef(0);

  const load = useCallback(
    async (reason: DiaryReason) => {
      const id = current.current;
      if (!id) return;
      lastFetchAt.current = clock();
      try {
        const res = await backend.getDiary(id, reason);
        if (current.current !== id || res.practitionerId !== id) return; // stale response
        const appointments = res.appointments.map(fromDiaryDto).filter((a): a is DiaryAppointment => a !== null);
        setState({
          practitionerId: id,
          appointments,
          timeZone: res.timeZone,
          rejectedCount: res.rejectedCount + (res.appointments.length - appointments.length),
          loading: false,
          error: null,
          lastOkAt: clock(),
        });
      } catch (err) {
        if (current.current !== id) return;
        const error = err instanceof BackendError ? err : new BackendError('UNKNOWN', 'The diary could not be loaded.');
        setState((s) => ({ ...s, loading: false, error }));
      }
    },
    [backend, clock],
  );

  useEffect(() => {
    current.current = practitionerId;
    setState(empty(practitionerId));
    if (!practitionerId) return;
    void load('INITIAL');

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = document.visibilityState === 'visible' ? VISIBLE_REFRESH_MS : HIDDEN_REFRESH_MS;
      timer = setTimeout(async () => {
        await load('REFRESH');
        schedule();
      }, delay);
    };
    schedule();

    // Coming back to the tab: refresh straight away if the last fetch is more than 30 seconds old.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && clock() - lastFetchAt.current > 30_000) void load('REFRESH');
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [practitionerId, load, clock]);

  const refresh = useCallback(() => load('MANUAL'), [load]);
  return { ...state, refresh };
}
