import { useEffect, useState } from 'react';

export const CHANGE_GUARD_MS = 1500;

/**
 * Returns false for `ms` after `key` changes, then true.
 *
 * SAFETY (hazard H01): when the suggested patient changes while it is on screen (for example at the
 * turn of an appointment slot), confirm buttons stay disabled briefly so a tap aimed at one patient
 * cannot land on another. It is false in the very render where the key changes, and a quick change
 * away and back (A, B, A) holds again rather than re-enabling A at once.
 */
export function useChangeGuard(key: string, ms = CHANGE_GUARD_MS): boolean {
  const [seenKey, setSeenKey] = useState(key);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  if (seenKey !== key) {
    // Derived-state update during render: forget any earlier readiness the moment the key changes.
    setSeenKey(key);
    setReadyKey(null);
  }
  useEffect(() => {
    const t = setTimeout(() => setReadyKey(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return seenKey === key && readyKey === key;
}
