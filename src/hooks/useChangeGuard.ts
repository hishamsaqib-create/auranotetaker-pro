import { useEffect, useState } from 'react';

export const CHANGE_GUARD_MS = 1500;

/**
 * Returns false for `ms` after `key` changes, then true.
 *
 * SAFETY (hazard H01): when the suggested patient changes while it is on screen (for example at the
 * turn of an appointment slot), confirm buttons stay disabled briefly so a tap aimed at one patient
 * cannot land on another. It is false in the very render where the key changes, not one render later.
 */
export function useChangeGuard(key: string, ms = CHANGE_GUARD_MS): boolean {
  const [readyKey, setReadyKey] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setReadyKey(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return readyKey === key;
}
