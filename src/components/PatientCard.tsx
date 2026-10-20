import type { ReactNode } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { formatCalendarDate, formatTimeRange } from '../../lib/core/time.ts';
import type { SummaryState } from '../hooks/usePatientSummaries.ts';

export function displayNameFor(a: DiaryAppointment, summary: SummaryState | undefined): string {
  if (summary?.status === 'ok') return summary.data.displayName;
  return a.patientName ?? 'Unnamed patient';
}

function dobText(summary: SummaryState | undefined): string {
  if (!summary || summary.status === 'loading') return 'Loading…';
  if (summary.status === 'error') return 'Could not load from Dentally';
  return formatCalendarDate(summary.data.dateOfBirth) ?? 'Not recorded in Dentally';
}

export interface PatientCardProps {
  appointment: DiaryAppointment;
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
  size?: 'large' | 'compact';
  children?: ReactNode;
}

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
  size = 'large',
  children,
}: PatientCardProps) {
  const name = displayNameFor(appointment, summary);
  const room = appointment.roomId ? (roomNames[appointment.roomId] ?? 'Unknown surgery') : 'No surgery in Dentally';
  const disabled = !ready || busy;
  const hintId = `guard-${appointment.appointmentId}`;

  return (
    <article className={`patient patient-${size}`} aria-label={`Patient ${name}`}>
      <h2 className="patient-name">{name}</h2>
      <dl className="patient-facts">
        <div>
          <dt>Date of birth</dt>
          <dd>{dobText(summary)}</dd>
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
          className={`button button-primary confirm ${ready ? '' : 'confirm-holding'}`}
          disabled={disabled}
          aria-describedby={!ready ? hintId : undefined}
          onClick={onConfirm}
        >
          {busy ? 'Checking with Dentally…' : `Confirm ${name}`}
        </button>
        {!ready && (
          <span id={hintId} className="visually-hidden">
            Available in a moment. The suggestion has just changed.
          </span>
        )}
        {children}
      </div>
    </article>
  );
}
