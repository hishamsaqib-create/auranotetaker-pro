import '@fontsource-variable/atkinson-hyperlegible-next';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createBackend } from './backend/index.ts';
import { readConfig } from './config.ts';

const root = createRoot(document.getElementById('root')!);

try {
  const backend = createBackend(readConfig());
  root.render(
    <StrictMode>
      <App backend={backend} />
    </StrictMode>,
  );
} catch (err) {
  // Misconfiguration is shown, never papered over with demo data.
  root.render(
    <main className="gate">
      <p className="notice notice-bad" role="alert">
        AuraNoteTaker is not configured correctly: {err instanceof Error ? err.message : String(err)}
      </p>
    </main>,
  );
}
