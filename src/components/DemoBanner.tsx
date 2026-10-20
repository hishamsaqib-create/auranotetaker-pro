import { useState } from 'react';
import { formatClock } from '../../lib/core/time.ts';
import type { DemoScenario } from '../../lib/dentally/mock.ts';
import type { DemoControls } from '../backend/types.ts';

/** Permanent banner in demo mode, so fictional data can never be mistaken for a live diary. */
export function DemoBanner({ demo, onScenarioChange, timeZone }: { demo: DemoControls; onScenarioChange: () => void; timeZone: string }) {
  const [scenario, setScenario] = useState<DemoScenario>(demo.getScenario());
  const [showAudit, setShowAudit] = useState(false);
  const events = demo.auditEvents();

  return (
    <section className="demo-banner" aria-label="Demo mode">
      <div className="demo-tape" aria-hidden="true" />
      <p className="demo-text">
        <strong>Demo mode.</strong> Patients are fictional and nothing is connected to Dentally.
      </p>
      <label className="demo-control">
        <span>Scenario</span>
        <select
          value={scenario}
          onChange={(e) => {
            const s = e.target.value as DemoScenario;
            setScenario(s);
            demo.setScenario(s);
            onScenarioChange();
          }}
        >
          {demo.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="link-button" aria-expanded={showAudit} onClick={() => setShowAudit((v) => !v)}>
        {showAudit ? 'Hide audit trail' : `Show audit trail (${events.length})`}
      </button>
      {showAudit && (
        <div className="demo-audit" role="region" aria-label="Demo audit trail">
          {events.length === 0 ? (
            <p>No audit events yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">Patient ID</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {[...events].reverse().map((e, i) => (
                  <tr key={`${e.occurredAtMs}-${i}`}>
                    <td>{formatClock(e.occurredAtMs, timeZone)}</td>
                    <td>{e.action}</td>
                    <td>{e.actorEmail}</td>
                    <td>{e.dentallyPatientId ?? ''}</td>
                    <td>
                      {Object.entries(e.details)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
