import { useCallback, useEffect, useState } from 'react';
import { formatCalendarDate, formatTimeRange } from '../../lib/core/time.ts';
import type { NotesToDoResponse, NoteToDoItem } from '../../lib/server/handlers.ts';
import type { ClinicianEntry } from '../../lib/server/ports.ts';
import type { AppBackend } from '../backend/types.ts';
import { Notice } from './Notice.tsx';

const ALL = '__all__';

const SCRIBE_LABEL: Partial<Record<NonNullable<NoteToDoItem['scribeStatus']>, string>> = {
  PATIENT_CONFIRMED: 'Patient confirmed in AuraNoteTaker, nothing recorded',
  READY: 'Patient confirmed in AuraNoteTaker, nothing recorded',
  RECORDING: 'Still recording in AuraNoteTaker',
  PAUSED: 'Recording paused in AuraNoteTaker',
  STOPPED: 'Recorded in AuraNoteTaker',
  CONSENT_DECLINED: 'Patient declined the AI scribe',
  CANCELLED: 'AuraNoteTaker session cancelled',
};

export interface NotesToDoProps {
  backend: AppBackend;
  clinicians: ClinicianEntry[];
  /** Preselected clinician; null shows every clinician. */
  initialPractitionerId: string | null;
  timeZone: string;
  /** Clinical staff can tick notes off as written in Dentally; the practice manager only views. */
  canMark: boolean;
  onClose: () => void;
}

function dayLabel(date: string, dates: string[]): string {
  if (date === dates[0]) return `Today (${formatCalendarDate(date)})`;
  if (date === dates[1]) return `Yesterday (${formatCalendarDate(date)})`;
  return formatCalendarDate(date) ?? date;
}

/**
 * Appointments that have finished but have no note yet. AuraNoteTaker cannot read notes in Dentally, so a note
 * counts as done when it was copied from AuraNoteTaker for that appointment, or ticked off here as written in
 * Dentally. Appointments Dentally does not show as completed are listed separately, never hidden.
 */
export function NotesToDo({ backend, clinicians, initialPractitionerId, timeZone, canMark, onClose }: NotesToDoProps) {
  const [practitionerId, setPractitionerId] = useState<string>(initialPractitionerId ?? ALL);
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<NotesToDoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await backend.getNotesToDo({ date, practitionerId: practitionerId === ALL ? null : practitionerId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The list could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [backend, date, practitionerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mark(item: NoteToDoItem, written: boolean) {
    setBusy(item.appointmentId);
    setMarkError(null);
    try {
      const r = await backend.markNoteWritten(item.appointmentId, written);
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.map((i) => (i.appointmentId === r.appointmentId ? { ...i, note: r.note, markedBy: r.note === 'NOT_DONE' ? null : i.markedBy, markedAt: r.note === 'NOT_DONE' ? null : i.markedAt } : i)),
            }
          : d,
      );
      // Counts and who ticked it off come from the server.
      void load();
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : 'That could not be saved. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const items = data?.items ?? [];
  const notDone = items.filter((i) => i.note === 'NOT_DONE' && i.due === 'DUE');
  const toCheck = items.filter((i) => i.note === 'NOT_DONE' && i.due === 'CHECK');
  const done = items.filter((i) => i.note !== 'NOT_DONE');
  const showClinician = practitionerId === ALL;

  const row = (i: NoteToDoItem) => (
    <li key={i.appointmentId} className="todo-item">
      <div className="todo-main">
        <span>
          <span className="todo-time">{formatTimeRange(Date.parse(i.startTime), Date.parse(i.finishTime), timeZone)}</span>{' '}
          <strong>{i.patientName ?? 'Patient name not available'}</strong>
          {showClinician && i.clinicianName ? ` with ${i.clinicianName}` : ''}
        </span>
        <span className="todo-meta">
          {[i.reason, i.state === 'Unknown' ? `Dentally status: ${i.rawState ?? 'unknown'}` : `Dentally: ${i.state}`, i.scribeStatus ? SCRIBE_LABEL[i.scribeStatus] : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {i.note !== 'NOT_DONE' && (
          <span className="todo-done">
            {i.note === 'COPIED' ? 'Copied from AuraNoteTaker' : 'Ticked off as written in Dentally'}
            {i.markedBy ? ` by ${i.markedBy}` : ''}
          </span>
        )}
      </div>
      {canMark && i.note === 'NOT_DONE' && (
        <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void mark(i, true)}>
          {busy === i.appointmentId ? 'Saving…' : 'Written in Dentally'}
        </button>
      )}
      {canMark && i.note === 'WRITTEN_IN_DENTALLY' && (
        <button type="button" className="link-button" disabled={busy !== null} onClick={() => void mark(i, false)}>
          Undo
        </button>
      )}
    </li>
  );

  return (
    <main className="setup notes-screen">
      <button type="button" className="link-button" onClick={onClose}>
        Back
      </button>
      <h1>Notes to do</h1>
      <p className="state-lead">
        Finished appointments with no note yet. AuraNoteTaker cannot see notes typed straight into Dentally, so tick those off here.
      </p>

      <div className="todo-filters">
        <label className="field">
          <span className="field-label">Clinician</span>
          <select value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}>
            <option value={ALL}>All clinicians</option>
            {clinicians.map((c) => (
              <option key={c.practitionerId} value={c.practitionerId}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Day</span>
          <select value={date ?? data?.date ?? ''} onChange={(e) => setDate(e.target.value)} disabled={!data}>
            {(data?.dates ?? []).map((d) => (
              <option key={d} value={d}>
                {dayLabel(d, data!.dates)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button button-secondary" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <Notice tone="bad" title={error} />}
      {markError && <Notice tone="bad" title={markError} />}
      {data && data.rejectedCount > 0 && (
        <Notice tone="warn" title={`${data.rejectedCount} appointment${data.rejectedCount === 1 ? '' : 's'} from Dentally could not be read`}>
          They are not in this list. Check the diary in Dentally for this day.
        </Notice>
      )}

      {data && (
        <>
          <p className="todo-summary">
            <span>
              <strong>{data.outstandingCount}</strong> not done
            </span>
            <span>
              <strong>{data.checkCount}</strong> to check
            </span>
            <span>
              <strong>{data.doneCount}</strong> done
            </span>
            {data.laterCount > 0 && <span>{data.laterCount} still to come or in progress</span>}
          </p>

          <h2>Not done</h2>
          {notDone.length ? <ul className="todo-list">{notDone.map(row)}</ul> : <p className="state-lead">None.</p>}

          {toCheck.length > 0 && (
            <>
              <h2>Check in Dentally</h2>
              <p className="state-lead">Their time has passed, but Dentally does not show them as completed. If the patient was seen, they need a note.</p>
              <ul className="todo-list">{toCheck.map(row)}</ul>
            </>
          )}

          {done.length > 0 && (
            <>
              <h2>Done</h2>
              <ul className="todo-list">{done.map(row)}</ul>
            </>
          )}
        </>
      )}
    </main>
  );
}
