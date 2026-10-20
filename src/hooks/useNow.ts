import { useEffect, useState } from 'react';

/** The current time, updated every `intervalMs`. Browsers slow this down in hidden tabs, which is fine for display. */
export function useNow(intervalMs = 1000, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, clock]);
  return now;
}
