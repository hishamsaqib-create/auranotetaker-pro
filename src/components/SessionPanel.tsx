import { useEffect, useState } from 'react';
import type { ScribeSession } from '../../lib/core/session.ts';
import { formatCalendarDate, formatTimeRange } from '../../lib/core/time.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { LockIcon } from './icons.tsx';
import { Notice } from './Notice.tsx';
import type { ConfirmedPatientDisplay } from './PatientConfirmation.tsx';

export interface SessionPanelProps {
  backend: AppBackend;
  session: ScribeSession;
  display: ConfirmedPatientDisplay | null;
  timeZone: string;
  clinicianName: string;
  surgeryName: string | null;
  onSessionChange: (session: ScribeSession) => void;
  /** Close the panel. `finishedAppointmentId` is set when the appointment is done with (patient declined). */
  onClose: (finishedAppointmentId: string | null) => void;
  onReload: () => void;
}

const firstName = (name: string) => name.split(' ')[0] ?? name;

export function SessionPanel(p: SessionPanelProps) {
  const [display, setDisplay] = useState<ConfirmedPatientDisplay | null>(p.display);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const appt = p.session.patient.appointment;

  // After a page refresh only the session is known; look the patient's name up again for the banner.
  useEffect(() => {
    if (display) return;
    let cancelled = false;
    p.backend
      .getPatientSummary(appt.appointmentId)
      .then((s) => !cancelled && setDisplay({ displayName: s.displayName, dateOfBirth: s.dateOfBirth }))
      .catch(() => !cancelled && setDisplay({ displayName: `Patient ${p.session.patient.dentallyPatientId}`, dateOfBirth: null }));
    return () => {
      cancelled = true;
    };
  }, [display, p.backend, appt.appointmentId, p.session.patient.dentallyPatientId]);

  async function act(fn: () => Promise<{ session: ScribeSession }>, after?: (s: ScribeSession) => void) {
    setBusy(true);
    setError(null);
    try {
      const { session } = await fn();
      p.onSessionChange(session);
      after?.(session);
    } catch (err) {
      setError(err instanceof BackendError ? err : new BackendError('UNKNOWN', 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const name = display?.displayName ?? 'Loading patient…';
  const first = display ? firstName(display.displayName) : 'the patient';
  const s = p.session;

  return (
    <div className="session">
      <section className="locked" aria-label="Patient locked to this session">
        <div className="locked-label">
          <LockIcon />
          <span>Locked to this session</span>
        </div>
        <p className="locked-name">{name}</p>
        <dl className="locked-facts">
          <div>
            <dt>Date of birth</dt>
            <dd>{display ? (formatCalendarDate(display.dateOfBirth) ?? 'Not recorded') : '…'}</dd>
          </div>
          <div>
            <dt>Dentally ID</dt>
            <dd className="mono-digits">{s.patient.dentallyPatientId}</dd>
          </div>
          <div>
            <dt>Appointment</dt>
            <dd>
              <span className="mono-digits">{formatTimeRange(appt.startMs, appt.finishMs, p.timeZone)}</span>
              {appt.reason ? `, ${appt.reason}` : ''}
            </dd>
          </div>
          <div>
            <dt>With</dt>
            <dd>
              {p.clinicianName}
              {p.surgeryName ? `, ${p.surgeryName}` : ''}
            </dd>
          </div>
        </dl>
      </section>

      {error && (
        <Notice
          tone="bad"
          title={error.message}
          action={
            error.code === 'VERSION_CONFLICT' ? (
              <button type="button" className="button button-secondary" onClick={p.onReload}>
                Reload session
              </button>
            ) : undefined
          }
        />
      )}

      {s.status === 'PATIENT_CONFIRMED' && (
        <section className="step" aria-labelledby="consent-heading">
          <h1 id="consent-heading" className="state-title">
            Has {first} agreed to the AI scribe for this appointment?
          </h1>
          <p className="state-lead">
            You could say: "We use an assistant that listens to the appointment and drafts my notes. I check and approve everything, and the
            audio isn't kept. Are you happy for it to be used today?"
          </p>
          <div className="actions">
            <button type="button" className="button button-primary" disabled={busy} onClick={() => void act(() => p.backend.recordConsent(s.sessionId, true, s.version))}>
              Yes, {first} agreed
            </button>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => void act(() => p.backend.recordConsent(s.sessionId, false, s.version))}>
              No, {first} declined
            </button>
          </div>
          <button
            type="button"
            className="link-button step-escape"
            disabled={busy}
            onClick={() => void act(() => p.backend.cancelSession(s.sessionId, s.version), () => p.onClose(null))}
          >
            Wrong patient? Cancel this session
          </button>
        </section>
      )}

      {s.status === 'READY' && (
        <section className="step" aria-labelledby="ready-heading">
          <h1 id="ready-heading" className="state-title">
            Ready to record
          </h1>
          <p className="state-lead">
            {first} agreed. Recording arrives in Phase 2 of the build, so this version stops here. Nothing has been recorded.
          </p>
          <div className="actions">
            <button type="button" className="button button-record" disabled aria-describedby="record-note">
              Start scribe
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void act(() => p.backend.cancelSession(s.sessionId, s.version), () => p.onClose(null))}
            >
              End session
            </button>
          </div>
          <p id="record-note" className="visually-hidden">
            Recording is not available in this version.
          </p>
        </section>
      )}

      {s.status === 'CONSENT_DECLINED' && (
        <section className="step" aria-labelledby="declined-heading">
          <h1 id="declined-heading" className="state-title">
            Scribe off for this appointment
          </h1>
          <p className="state-lead">
            {first} declined. Nothing will be recorded, and nothing about this appointment will be sent for AI processing.
          </p>
          <div className="actions">
            <button type="button" className="button button-primary" onClick={() => p.onClose(appt.appointmentId)}>
              Done
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
