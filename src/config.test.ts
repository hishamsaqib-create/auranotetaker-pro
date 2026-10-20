import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

const production = { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true, SSR: false } as ImportMetaEnv;

describe('readConfig', () => {
  it('refuses a production build that does not say which mode it is', () => {
    expect(() => readConfig(production)).toThrow('VITE_APP_MODE is not set');
  });

  it('defaults to demo mode only on the development server', () => {
    expect(readConfig({ ...production, DEV: true, PROD: false, MODE: 'development' }).mode).toBe('demo');
  });

  it('rejects an unknown mode rather than falling back to demo data', () => {
    expect(() => readConfig({ ...production, VITE_APP_MODE: 'live' })).toThrow('Unknown VITE_APP_MODE');
  });

  it('reads the Base44 settings', () => {
    expect(readConfig({ ...production, VITE_APP_MODE: 'base44', VITE_BASE44_APP_ID: ' app-123 ' })).toEqual({
      mode: 'base44',
      base44AppId: 'app-123',
      base44ServerUrl: null,
    });
  });
});
