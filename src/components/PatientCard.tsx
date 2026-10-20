import type { ReactNode } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { formatCalendarDate, formatTimeRange } from '../../lib/core/time.ts';
import type { SummaryState } from '../hooks/usePatientSummaries.ts';

/** True only when Dentally's own record for this appointment names the patient the diary shows. */
export function isVerified(a: DiaryAppointment, summary: SummaryState | undefined): boolean {
  return summary?.status === 'ok' && a.patientId !== null && summary.data.patientId === a.patientId;
}

function cardName(a: DiaryAppointment, summary: SummaryState | undefined): string {
  if (isVerified(a, summary) && summary?.status === 'ok') return summary.data.displayName;
  return a.patientName ?? 'Unnamed patient';
}

function dobText(summary: SummaryState | undefined): string {
  if (!summary || summary.status === 'loading') return 'Checking with Dentally…';
  if (summary.status === 'error') return 'Could not load from Dentally';
  if (summary.status === 'mismatch') return 'Dentally now shows a different patient';
  return formatCalendarDate(summary.data.dateOfBirth) ?? 'Not recorded in Dentally';
}

export interface PatientCardProps {
  appointment: DiaryAppointment;
  /** Name and date of birth from Dentally for exactly this appointment and patient (see usePatientSummaries). */
  summary: SummaryState | undefined;
  timeZone: string;
  clinicianName: string;
  roomNames: Readonly<Record<string, string>>;
  /** Why this patient is suggested. Omitted for patients picked from the diary. */
  reasons?: readonly string[];
  /** False while the change guard is holding (see useChangeGuard). */
  ready: boolean;
  busy: boolean;
  onConfirm: () => void;
  /** Fetches the diary again; offered when the patient's details could not be checked. */
  onRetry?: () => void;
  size?: 'large' | 'compact';
  children?: ReactNode;
}

/**
 * One patient to confirm: name, date of birth and Dentally ID for the identity check, the booking, and
 * a confirm button that names the patient.
 *
 * SAFETY (hazard H01): the button stays disabled until Dentally has returned this appointment's patient
 * and it is the patient the diary shows, and while the change guard holds. A patient whose details
 * cannot be checked cannot be confirmed.
 */
export function PatientCard({
  appointment,
  summary,
  timeZone,
  clinicianName,
  roomNames,
  reasons,
  ready,
  busy,
  onConfirm,
  onRetry,
  size = 'large',
  children,
}: PatientCardProps) {
  const name = cardName(appointment, summary);
  const verified = isVerified(appointment, summary);
  const room = appointment.roomId ? (roomNames[appointment.roomId] ?? 'Unknown surgery') : 'No surgery in Dentally';
  const disabled = !ready || busy || !verified;
  const hintId = `confirm-hint-${appointment.appointmentId}`;

  const check: { text: string; tone: 'muted' | 'bad' } | null = verified
    ? null
    : summary?.status === 'error'
      ? { text: "The patient's details could not be loaded from Dentally, so they cannot be confirmed yet.", tone: 'bad' }
      : summary?.status === 'mismatch'
        ? { text: 'Dentally now shows a different patient for this appointment. Refresh the diary and check again.', tone: 'bad' }
        : { text: "Confirm becomes available once Dentally has returned the patient's details.", tone: 'muted' };

  return (
    <article className={`patient patient-${size}`} aria-label={`Patient ${name}`}>
      <h2 className="patient-name">{name}</h2>
      <dl className="patient-facts">
        <div>
          <dt>Date of birth</dt>
          <dd className={summary?.status === 'mismatch' || summary?.status === 'error' ? 'fact-bad' : undefined}>{dobText(summary)}</dd>
        </div>
        <div>
          <dt>Dentally ID</dt>
          <dd className="mono-digits">{appointment.patientId}</dd>
        </div>
        <div>
          <dt>Appointment</dt>
          <dd>
            <span className="mono-digits">{formatTimeRange(appointment.startMs, appointment.finishMs, timeZone)}</span>
            {appointment.reason ? `, ${appointment.reason}` : ''}
          </dd>
        </div>
        <div>
          <dt>With</dt>
          <dd>
            {clinicianName}, {room}
          </dd>
        </div>
        <div>
          <dt>Dentally status</dt>
          <dd>{appointment.state === 'Unknown' ? `Unrecognised (${appointment.rawState ?? 'blank'})` : appointment.state}</dd>
        </div>
      </dl>

      {reasons && reasons.length > 0 && (
        <div className="reasons">
          <h3>Why this patient</h3>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className={`button button-primary confirm ${ready && verified ? '' : 'confirm-holding'}`}
          disabled={disabled}
          aria-describedby={disabled && !busy ? hintId : undefined}
          onClick={onConfirm}
        >
          {busy ? 'Checking with Dentally…' : `Confirm ${name}`}
        </button>
        {children}
      </div>
      {check ? (
        <p id={hintId} className={`confirm-check confirm-check-${check.tone}`} role={check.tone === 'bad' ? 'alert' : undefined}>
          {check.text}
          {onRetry && check.tone === 'bad' && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onRetry}>
                Refresh the diary
              </button>
            </>
          )}
        </p>
      ) : (
        !ready && (
          <span id={hintId} className="visually-hidden">
            Available in a moment. The suggestion has just changed.
          </span>
        )
      )}
    </article>
  );
}
