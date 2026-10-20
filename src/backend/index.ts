import type { AppConfig } from '../config.ts';
import { createBase44Backend } from './base44Backend.ts';
import { createDemoBackend } from './demoBackend.ts';
import type { AppBackend } from './types.ts';

export function createBackend(config: AppConfig): AppBackend {
  if (config.mode === 'demo') return createDemoBackend();
  if (!config.base44AppId) throw new Error('VITE_BASE44_APP_ID is required when VITE_APP_MODE is "base44".');
  return createBase44Backend({ appId: config.base44AppId, serverUrl: config.base44ServerUrl ?? undefined });
}
