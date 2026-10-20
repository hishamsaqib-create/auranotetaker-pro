import { useEffect, useState } from 'react';
import type { ScribeSession } from '../../lib/core/session.ts';
import { canCancel } from '../../lib/core/session.ts';
import { formatCalendarDate, formatTimeRange, zonedDateString } from '../../lib/core/time.ts';
import type { PatientSummary } from '../../lib/dentally/types.ts';
import type { SessionRestriction } from '../../lib/server/handlers.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { LockIcon } from './icons.tsx';
import { Notice } from './Notice.tsx';
import type { ScribeWorkspaceProps } from './ScribeWorkspace.tsx';
import { ScribeWorkspace } from './ScribeWorkspace.tsx';

export interface SessionPanelProps {
  backend: AppBackend;
  session: ScribeSession;
  /** Set when this session cannot be continued from this computer: only Cancel is offered. */
  restriction: SessionRestriction | null;
  /** The identity the server verified at confirmation, when this screen did the confirming. */
  patient: PatientSummary | null;
  /** The surgery this computer is set up for. */
  currentSurgeryId: string;
  timeZone: string;
  clinicianName: string;
  /** The surgery the session was started in. */
  surgeryName: string | null;
  onSessionChange: (session: ScribeSession) => void;
  /** Close the panel. `declinedAppointmentId` is set when the patient declined the scribe. */
  onClose: (declinedAppointmentId: string | null) => void;
  onReload: () => void;
  /** Tests only: fake microphone and speech-to-text. */
  scribeDevices?: Pick<ScribeWorkspaceProps, 'startCapture' | 'listMicrophones' | 'connect'>;
}

type PatientDisplay = { status: 'ok'; patient: PatientSummary } | { status: 'loading' } | { status: 'error' };

const firstName = (name: string) => name.split(' ')[0] ?? name;

/** Errors that mean the screen's view of the session is out of date. */
const RELOAD_AFTER = new Set(['VERSION_CONFLICT', 'SURGERY_MISMATCH', 'NOT_TODAY', 'FORBIDDEN', 'SESSION_TRANSITION_REFUSED', 'SESSION_EXPIRED']);

/**
 * The open session, with its locked patient always on screen.
 *
 * SAFETY (hazards H01, H18): the banner names the patient by the ID locked to the session (looked up
 * again by that ID after a page refresh, never by appointment, which Dentally can re-book). A session
 * this computer cannot continue offers only Cancel, mirroring the server's checks.
 */
export function SessionPanel(p: SessionPanelProps) {
  const lockedId = p.session.patient.dentallyPatientId;
  const [display, setDisplay] = useState<PatientDisplay>(() =>
    p.patient && p.patient.patientId === lockedId ? { status: 'ok', patient: p.patient } : { status: 'loading' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const appt = p.session.patient.appointment;
  const s = p.session;

  // After a page refresh only the session is known: look its patient up again by the locked patient ID.
  useEffect(() => {
    if (display.status !== 'loading') return;
    let cancelled = false;
    p.backend
      .getSessionPatient(s.sessionId)
      .then((patient) => {
        if (cancelled) return;
        setDisplay(patient.patientId === lockedId ? { status: 'ok', patient } : { status: 'error' });
      })
      .catch(() => !cancelled && setDisplay({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [display.status, p.backend, s.sessionId, lockedId]);

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

  const cancel = () => void act(() => p.backend.cancelSession(s.sessionId, s.version), () => p.onClose(null));
  const answer = (given: boolean) => void act(() => p.backend.recordConsent(s.sessionId, given, s.version, p.currentSurgeryId));

  const name = display.status === 'ok' ? display.patient.displayName : display.status === 'loading' ? 'Loading patient…' : `Patient ${lockedId}`;
  const first = display.status === 'ok' ? firstName(display.patient.displayName) : 'the patient';
  const dob = display.status === 'ok' ? (formatCalendarDate(display.patient.dateOfBirth) ?? 'Not recorded') : display.status === 'loading' ? '…' : 'Not available';
  const nothingRecorded = s.status === 'PATIENT_CONFIRMED' || s.status === 'READY';
  const where = p.surgeryName ?? 'another surgery';

  return (
    <div className="session">
      <section className="locked" aria-label="Patient locked to this session">
        <div className="locked-label">
          <LockIcon />
          <span>Locked to this session</span>
        </div>
        <p className="locked-name">{name}</p>
        {display.status === 'error' && <p className="locked-note">The name could not be loaded from Dentally. The session is still locked to this patient ID.</p>}
        <dl className="locked-facts">
          <div>
            <dt>Date of birth</dt>
            <dd>{dob}</dd>
          </div>
          <div>
            <dt>Dentally ID</dt>
            <dd className="mono-digits">{lockedId}</dd>
          </div>
          <div>
            <dt>Appointment</dt>
            <dd>
              {/* The date is always shown, so a session left over from another day cannot pass for today's. */}
              {formatCalendarDate(zonedDateString(appt.startMs, p.timeZone))},{' '}
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
            RELOAD_AFTER.has(error.code) ? (
              <button type="button" className="button button-secondary" onClick={p.onReload}>
                Reload session
              </button>
            ) : undefined
          }
        />
      )}

      {p.restriction ? (
        <section className="step" aria-labelledby="restricted-heading">
          <h1 id="restricted-heading" className="state-title">
            {p.restriction === 'OTHER_SURGERY'
              ? `This session is open in ${where}`
              : p.restriction === 'PREVIOUS_DAY'
                ? 'This session is from an earlier day'
                : 'Someone else is running this session'}
          </h1>
          <p className="state-lead">
            {p.restriction === 'OTHER_SURGERY'
              ? `${p.clinicianName}'s session for this patient was started in ${where}. Continue it there, or cancel it here if it is no longer needed.`
              : p.restriction === 'PREVIOUS_DAY'
                ? "It was never finished and cannot be continued. Cancel it to start today's sessions."
                : `${s.confirmation.confirmedBy} confirmed this patient. Only they or ${p.clinicianName} can record the patient's answer. If the session is no longer needed, cancel it.`}
            {nothingRecorded ? ' Nothing has been recorded.' : ''}
          </p>
          {canCancel(s.status) ? (
            <div className="actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={cancel}>
                Cancel this session
              </button>
            </div>
          ) : (
            <p className="state-lead">
              This session already has a recording, so it cannot be cancelled here. Continue it where it was started, or ask the practice
              manager.
            </p>
          )}
        </section>
      ) : (
        <>
          {s.status === 'PATIENT_CONFIRMED' && (
            <section className="step" aria-labelledby="consent-heading">
              <h1 id="consent-heading" className="state-title">
                Has {first} agreed to the AI scribe for this appointment?
              </h1>
              <p className="state-lead">
                You could say: "We use an assistant that listens to the appointment and drafts my notes. I check and approve everything, and
                the audio isn't kept. Are you happy for it to be used today?"
              </p>
              <div className="actions">
                <button type="button" className="button button-primary" disabled={busy} onClick={() => answer(true)}>
                  Yes, {first} agreed
                </button>
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => answer(false)}>
                  No, {first} declined
                </button>
              </div>
              <button type="button" className="link-button step-escape" disabled={busy} onClick={cancel}>
                Wrong patient? Cancel this session
              </button>
            </section>
          )}

          {(s.status === 'READY' || s.status === 'RECORDING' || s.status === 'PAUSED' || s.status === 'STOPPED') && (
            <ScribeWorkspace
              backend={p.backend}
              session={s}
              surgeryId={p.currentSurgeryId}
              timeZone={p.timeZone}
              firstName={first}
              onSessionChange={p.onSessionChange}
              onWithdraw={() => act(() => p.backend.recordConsent(s.sessionId, false, s.version, p.currentSurgeryId))}
              onCancel={cancel}
              {...p.scribeDevices}
            />
          )}

          {s.status === 'CONSENT_DECLINED' && (
            <section className="step" aria-labelledby="declined-heading">
              <h1 id="declined-heading" className="state-title">
                Scribe off for this appointment
              </h1>
              <p className="state-lead">
                {first === 'the patient' ? 'The patient' : first} declined.{' '}
                {s.recordingStartedAtMs !== null ? 'Recording stopped and what was captured has been deleted, and' : 'Nothing will be recorded, and'}{' '}
                nothing about this appointment will be sent for AI processing.
              </p>
              <div className="actions">
                <button type="button" className="button button-primary" onClick={() => p.onClose(appt.appointmentId)}>
                  Done
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
