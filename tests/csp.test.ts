import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEECHMATICS_RT_URL } from '../lib/speech/speechmatics.ts';
import { CSP } from '../vite.config.ts';

describe('Content Security Policy', () => {
  it('allows the Speechmatics endpoint the scribe connects to, and nothing broader', () => {
    const connect = CSP.split('; ').find((d) => d.startsWith('connect-src'))!;
    expect(connect.split(' ')).toContain(new URL(SPEECHMATICS_RT_URL).origin);
    expect(connect).not.toMatch(/\*|https:\s|wss:\s/);
  });

  it('serves the audio worklet from the app itself, so scripts stay self-only', () => {
    expect(CSP).toContain("script-src 'self';");
    expect(existsSync('public/pcm-capture-worklet.js')).toBe(true);
  });
});
