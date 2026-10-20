import { useEffect, useState } from 'react';
import type { PatientSummaryResponse } from '../../lib/server/handlers.ts';
import type { AppBackend } from '../backend/types.ts';

export type SummaryState =
  | { status: 'loading' }
  | { status: 'ok'; data: PatientSummaryResponse }
  | { status: 'error'; message: string };

/**
 * Name and date of birth for the appointments currently shown on confirm cards. Fetched only for
 * those (not the whole diary) and kept in memory only. Failed lookups are retried whenever
 * `retryToken` changes (the caller passes the time of the last successful diary refresh).
 */
export function usePatientSummaries(
  backend: AppBackend,
  appointmentIds: readonly string[],
  retryToken: unknown = null,
): ReadonlyMap<string, SummaryState> {
  const [cache, setCache] = useState<ReadonlyMap<string, SummaryState>>(new Map());
  const key = [...new Set(appointmentIds)].sort().join('|');

  useEffect(() => {
    const wanted = key ? key.split('|') : [];
    const missing = wanted.filter((id) => {
      const entry = cache.get(id);
      return !entry || entry.status === 'error';
    });
    if (missing.length === 0) return;
    setCache((prev) => {
      const next = new Map(prev);
      for (const id of missing) next.set(id, { status: 'loading' });
      return next;
    });
    for (const id of missing) {
      backend
        .getPatientSummary(id)
        .then((data) => setCache((prev) => new Map(prev).set(id, { status: 'ok', data })))
        .catch((err: unknown) =>
          setCache((prev) =>
            new Map(prev).set(id, { status: 'error', message: err instanceof Error ? err.message : 'Could not load patient details.' }),
          ),
        );
    }
    // `cache` is deliberately not a dependency: only the shown appointments or a retry should trigger fetches.
  }, [backend, key, retryToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return cache;
}
