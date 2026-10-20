export interface AppConfig {
  mode: 'demo' | 'base44';
  base44AppId: string | null;
  base44ServerUrl: string | null;
}

/** Reads build-time settings. An unknown mode is an error, never a silent fall-back to demo data. */
export function readConfig(env: ImportMetaEnv = import.meta.env): AppConfig {
  const mode = (env.VITE_APP_MODE ?? 'demo').trim();
  if (mode !== 'demo' && mode !== 'base44') throw new Error(`Unknown VITE_APP_MODE "${mode}". Use "demo" or "base44".`);
  return {
    mode,
    base44AppId: env.VITE_BASE44_APP_ID?.trim() || null,
    base44ServerUrl: env.VITE_BASE44_SERVER_URL?.trim() || null,
  };
}
