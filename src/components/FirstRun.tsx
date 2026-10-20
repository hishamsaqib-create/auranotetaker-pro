import { useState } from 'react';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { HaloMark } from './icons.tsx';

/** Shown when the backend says no clinic exists yet. Only the Base44 app's owner can complete it. */
export function FirstRun({ backend, onDone, onSignOut }: { backend: AppBackend; onDone: () => void; onSignOut: () => void }) {
  const [clinicName, setClinicName] = useState('Aura Dental Clinic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setUp() {
    setBusy(true);
    setError(null);
    try {
      await backend.bootstrapClinic(clinicName);
      onDone();
    } catch (err) {
      if (err instanceof BackendError && err.code === 'ALREADY_SET_UP') {
        onDone();
        return;
      }
      setError(err instanceof Error ? err.message : 'Setup did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-panel">
        <div className="brand brand-large">
          <HaloMark size={26} />
          <span>AuraNoteTaker Pro</span>
        </div>
        <h1>Set up AuraNoteTaker</h1>
        <p className="gate-lead">
          This app has no clinic yet. Setting it up makes you its practice manager. You then choose the clinicians and surgeries from
          Dentally, and add staff.
        </p>
        {error && (
          <p className="notice notice-bad" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span className="field-label">Clinic name</span>
          <input className="input" value={clinicName} maxLength={80} onChange={(e) => setClinicName(e.target.value)} />
        </label>
        <div className="actions">
          <button type="button" className="button button-primary" disabled={busy || clinicName.trim().length < 2} onClick={() => void setUp()}>
            {busy ? 'Setting up…' : 'Set up AuraNoteTaker'}
          </button>
          <button type="button" className="button button-quiet" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
