import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { fromDiaryDto } from '../../lib/core/appointments.ts';
import type { PredictionOptions } from '../../lib/core/prediction.ts';
import type { ScribeOutcome } from '../../lib/server/handlers.ts';
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
  /** Appointments already finished with in AuraNoteTaker today, as the server knows them (survives a page refresh). */
  scribeOutcomes: Readonly<Record<string, ScribeOutcome>>;
  /** The clinic's prediction settings, so this screen predicts exactly as the server does. */
  predictionOptions: Partial<PredictionOptions>;
  /** Server time minus this computer's time, measured at the last successful fetch. Null until known. */
  clockOffsetMs: number | null;
  loading: boolean;
  error: BackendError | null;
  /** Time (this computer's clock) of the last successful fetch. */
  lastOkAt: number | null;
}

const empty = (practitionerId: string | null): DiaryState => ({
  practitionerId,
  appointments: [],
  timeZone: null,
  rejectedCount: 0,
  scribeOutcomes: {},
  predictionOptions: {},
  clockOffsetMs: null,
  loading: practitionerId !== null,
  error: null,
  lastOkAt: null,
});

/**
 * Today's diary for one clinician, refreshed every minute while visible and every five while hidden.
 *
 * SAFETY (hazard H01): switching clinician clears the previous clinician's diary immediately, and only
 * the newest request's answer is used: a slow response for a clinician no longer selected, or one
 * overtaken by a newer refresh, is discarded, so an older diary never replaces a newer one.
 */
export function useDiary(backend: AppBackend, practitionerId: string | null, clock: () => number = Date.now) {
  const [state, setState] = useState<DiaryState>(() => empty(practitionerId));
  const current = useRef(practitionerId);
  const latestRequest = useRef(0);
  const lastFetchAt = useRef(0);

  const load = useCallback(
    async (reason: DiaryReason) => {
      const id = current.current;
      if (!id) return;
      const request = ++latestRequest.current;
      const sentAt = clock();
      lastFetchAt.current = sentAt;
      try {
        const res = await backend.getDiary(id, reason);
        if (request !== latestRequest.current || current.current !== id || res.practitionerId !== id) return; // overtaken
        const receivedAt = clock();
        const serverMs = Date.parse(res.fetchedAt);
        const appointments = res.appointments.map(fromDiaryDto).filter((a): a is DiaryAppointment => a !== null);
        setState({
          practitionerId: id,
          appointments,
          timeZone: res.timeZone,
          rejectedCount: res.rejectedCount + (res.appointments.length - appointments.length),
          scribeOutcomes: res.scribeOutcomes ?? {},
          predictionOptions: res.predictionOptions ?? {},
          // The server read its clock somewhere between sending and receiving; the midpoint is the best estimate.
          clockOffsetMs: Number.isFinite(serverMs) ? Math.round(serverMs - (sentAt + receivedAt) / 2) : null,
          loading: false,
          error: null,
          lastOkAt: receivedAt,
        });
      } catch (err) {
        if (request !== latestRequest.current || current.current !== id) return;
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
    let stopped = false; // a refresh still in flight when the clinician changes must not start a second timer loop
    const schedule = () => {
      if (stopped) return;
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
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [practitionerId, load, clock]);

  const refresh = useCallback(() => load('MANUAL'), [load]);
  return { ...state, refresh };
}
