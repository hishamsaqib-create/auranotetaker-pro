import { useEffect, useState } from 'react';
import type { PatientSummaryResponse } from '../../lib/server/handlers.ts';
import type { AppBackend } from '../backend/types.ts';

export type SummaryState =
  | { status: 'loading' }
  | { status: 'ok'; data: PatientSummaryResponse }
  | { status: 'mismatch' }
  | { status: 'error'; message: string };

export interface SummaryRequest {
  appointmentId: string;
  patientId: string;
}

export const summaryKey = (r: SummaryRequest) => `${r.appointmentId}:${r.patientId}`;

/**
 * Name and date of birth for the patients currently shown on confirm cards, fetched only for those
 * (not the whole diary) and kept in memory only.
 *
 * SAFETY (hazard H01): entries are keyed by appointment AND patient, so a re-booked appointment never
 * shows the previous patient's name. A response for a different patient than the diary shows is
 * recorded as a mismatch, never displayed. Failed lookups are retried when `retryToken` changes.
 */
export function usePatientSummaries(
  backend: AppBackend,
  requests: readonly SummaryRequest[],
  retryToken: unknown = null,
): ReadonlyMap<string, SummaryState> {
  const [cache, setCache] = useState<ReadonlyMap<string, SummaryState>>(new Map());
  const key = [...new Set(requests.map(summaryKey))].sort().join('|');

  useEffect(() => {
    const wanted = key ? key.split('|') : [];
    const missing = wanted.filter((k) => {
      const entry = cache.get(k);
      return !entry || entry.status === 'error' || entry.status === 'mismatch';
    });
    if (missing.length === 0) return;
    setCache((prev) => {
      const next = new Map(prev);
      for (const k of missing) next.set(k, { status: 'loading' });
      return next;
    });
    for (const k of missing) {
      const [appointmentId, patientId] = k.split(':') as [string, string];
      backend
        .getPatientSummary(appointmentId)
        .then((data) =>
          setCache((prev) => new Map(prev).set(k, data.patientId === patientId ? { status: 'ok', data } : { status: 'mismatch' })),
        )
        .catch((err: unknown) =>
          setCache((prev) =>
            new Map(prev).set(k, { status: 'error', message: err instanceof Error ? err.message : 'Could not load patient details.' }),
          ),
        );
    }
    // `cache` is deliberately not a dependency: only the shown patients or a retry should trigger fetches.
  }, [backend, key, retryToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return cache;
}
