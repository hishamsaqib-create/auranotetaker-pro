import { useState } from 'react';
import type { SetupOptionsResponse } from '../../lib/server/handlers.ts';

export interface DeviceSetup {
  practitionerId: string;
  surgeryId: string | null;
}

const KEY = 'auranotetaker.device-setup.v1';

/** Clinician and surgery for this computer. Two IDs only, no patient data. */
export function loadDeviceSetup(options: SetupOptionsResponse): DeviceSetup | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceSetup>;
    const clinicianOk = options.clinicians.some((c) => c.practitionerId === parsed.practitionerId);
    const surgeryOk = parsed.surgeryId == null || options.surgeries.some((s) => s.surgeryId === parsed.surgeryId);
    return clinicianOk && surgeryOk ? { practitionerId: parsed.practitionerId!, surgeryId: parsed.surgeryId ?? null } : null;
  } catch {
    return null;
  }
}

export function saveDeviceSetup(setup: DeviceSetup): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(setup));
  } catch {
    // Private browsing or blocked storage: the choice simply is not remembered.
  }
}

export function Setup({
  options,
  initial,
  onSave,
  onCancel,
}: {
  options: SetupOptionsResponse;
  initial: DeviceSetup | null;
  onSave: (setup: DeviceSetup) => void;
  onCancel?: () => void;
}) {
  const [practitionerId, setPractitionerId] = useState<string | null>(initial?.practitionerId ?? null);
  const [surgeryId, setSurgeryId] = useState<string | null>(initial?.surgeryId ?? null);
  const clinician = options.clinicians.find((c) => c.practitionerId === practitionerId);
  const surgery = options.surgeries.find((s) => s.surgeryId === surgeryId);

  return (
    <main className="setup">
      <h1>Who is this computer working with?</h1>
      <p className="setup-lead">Choose the clinician and the surgery. This computer remembers them until you change them.</p>

      <fieldset className="setup-group">
        <legend>Clinician</legend>
        <div className="tile-grid">
          {options.clinicians.map((c) => (
            <label key={c.practitionerId} className={`tile ${practitionerId === c.practitionerId ? 'tile-selected' : ''}`}>
              <input
                type="radio"
                name="clinician"
                value={c.practitionerId}
                checked={practitionerId === c.practitionerId}
                onChange={() => setPractitionerId(c.practitionerId)}
              />
              <span className="tile-title">{c.displayName}</span>
              <span className="tile-sub">{c.clinicianType.charAt(0) + c.clinicianType.slice(1).toLowerCase()}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="setup-group">
        <legend>Surgery</legend>
        <div className="tile-grid">
          {options.surgeries.map((s) => (
            <label key={s.surgeryId} className={`tile ${surgeryId === s.surgeryId ? 'tile-selected' : ''}`}>
              <input type="radio" name="surgery" value={s.surgeryId} checked={surgeryId === s.surgeryId} onChange={() => setSurgeryId(s.surgeryId)} />
              <span className="tile-title">{s.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!clinician || !surgery}
          onClick={() => practitionerId && onSave({ practitionerId, surgeryId })}
        >
          {clinician && surgery ? `Use this computer for ${clinician.displayName} in ${surgery.name}` : 'Choose a clinician and a surgery'}
        </button>
        {onCancel && (
          <button type="button" className="button button-quiet" onClick={onCancel}>
            Keep current setup
          </button>
        )}
      </div>
    </main>
  );
}
