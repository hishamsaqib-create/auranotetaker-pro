import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'demo';

/** A status with a shape and a word, never colour alone. */
export function StatusPill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
