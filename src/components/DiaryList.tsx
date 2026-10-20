import type { Ref } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import { formatClock, formatTimeRange } from '../../lib/core/time.ts';
import { RefreshIcon } from './icons.tsx';

export interface DiaryListProps {
  clinicianName: string;
  appointments: readonly DiaryAppointment[];
  timeZone: string;
  roomNames: Readonly<Record<string, string>>;
  currentIds: ReadonlySet<string>;
  finishedIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (a: DiaryAppointment) => void;
  loading: boolean;
  lastOkAt: number | null;
  rejectedCount: number;
  onRefresh: () => void;
  listRef?: Ref<HTMLOListElement>;
}

function selectable(a: DiaryAppointment): boolean {
  return a.patientId !== null && a.state !== 'Cancelled' && a.state !== 'Did not attend';
}

export function DiaryList(p: DiaryListProps) {
  return (
    <section className="diary" aria-labelledby="diary-heading">
      <div className="diary-head">
        <h2 id="diary-heading">Today with {p.clinicianName}</h2>
        <button type="button" className="link-button diary-refresh" onClick={p.onRefresh}>
          <RefreshIcon />
          {p.lastOkAt ? `Updated ${formatClock(p.lastOkAt, p.timeZone)}` : 'Refresh'}
        </button>
      </div>
      {p.rejectedCount > 0 && (
        <p className="notice notice-warn">
          {p.rejectedCount === 1
            ? '1 appointment could not be read from Dentally and is not shown.'
            : `${p.rejectedCount} appointments could not be read from Dentally and are not shown.`}
        </p>
      )}
      {p.loading && p.appointments.length === 0 ? (
        <p className="diary-empty">Loading the diary…</p>
      ) : p.appointments.length === 0 ? (
        <p className="diary-empty">No appointments today.</p>
      ) : (
        <ol className="diary-list" ref={p.listRef} tabIndex={-1} aria-label={`Appointments today with ${p.clinicianName}`}>
          {p.appointments.map((a) => {
            const isCurrent = p.currentIds.has(a.appointmentId);
            const isFinished = p.finishedIds.has(a.appointmentId);
            const isSelected = p.selectedId === a.appointmentId;
            const time = formatTimeRange(a.startMs, a.finishMs, p.timeZone);
            const body = (
              <>
                <span className="diary-time mono-digits">{time}</span>
                <span className="diary-main">
                  <span className="diary-name">{a.patientId ? (a.patientName ?? 'Unnamed patient') : 'No patient'}</span>
                  <span className="diary-reason">{a.reason ?? ''}</span>
                </span>
                <span className="diary-tags">
                  {isCurrent && <span className="tag tag-now">Now</span>}
                  {isFinished && <span className="tag">Scribe done</span>}
                  <span className={`tag tag-state state-${a.state.replace(/\s+/g, '-').toLowerCase()}`}>{a.state}</span>
                </span>
              </>
            );
            return (
              <li key={a.appointmentId} className={`diary-row ${isSelected ? 'is-selected' : ''} ${selectable(a) ? '' : 'is-muted'}`}>
                {selectable(a) ? (
                  <button type="button" className="diary-button" aria-pressed={isSelected} onClick={() => p.onSelect(a)}>
                    {body}
                  </button>
                ) : (
                  <div className="diary-static">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
