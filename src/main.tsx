import '@fontsource-variable/atkinson-hyperlegible-next';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createBackend } from './backend/index.ts';
import { readConfig } from './config.ts';

const root = createRoot(document.getElementById('root')!);

function stop(message: string) {
  root.render(
    <main className="gate">
      <p className="notice notice-bad" role="alert">
        {message}
      </p>
    </main>,
  );
}

function start() {
  let config;
  try {
    config = readConfig();
  } catch (err) {
    // Misconfiguration is shown, never papered over with demo data.
    stop(`AuraNoteTaker is not configured correctly: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Clickjacking defence for the connected app until the host sends a frame-ancestors header
  // (docs/deployment.md section 7). The demo holds only fictional data, so it may be framed.
  if (config.mode === 'base44' && window.top !== window.self) {
    stop('AuraNoteTaker cannot run inside another page. Open it in its own browser tab.');
    return;
  }
  try {
    const backend = createBackend(config);
    root.render(
      <StrictMode>
        <App backend={backend} />
      </StrictMode>,
    );
  } catch (err) {
    stop(`AuraNoteTaker is not configured correctly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

start();
