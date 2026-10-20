export interface AppConfig {
  mode: 'demo' | 'base44';
  base44AppId: string | null;
  base44ServerUrl: string | null;
}

/**
 * Reads build-time settings. An unknown mode is an error, never a silent fall-back to demo data.
 * The development server defaults to demo mode; a production build must say which mode it is, so a
 * deployment that forgot its settings shows an error instead of a fictional diary.
 */
export function readConfig(env: ImportMetaEnv = import.meta.env): AppConfig {
  const raw = env.VITE_APP_MODE?.trim();
  if (!raw && !env.DEV) throw new Error('VITE_APP_MODE is not set. Production builds must set it to "base44" (or "demo" for a demonstration).');
  const mode = raw || 'demo';
  if (mode !== 'demo' && mode !== 'base44') throw new Error(`Unknown VITE_APP_MODE "${mode}". Use "demo" or "base44".`);
  return {
    mode,
    base44AppId: env.VITE_BASE44_APP_ID?.trim() || null,
    base44ServerUrl: env.VITE_BASE44_SERVER_URL?.trim() || null,
  };
}
