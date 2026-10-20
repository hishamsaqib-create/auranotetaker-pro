import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import type { Candidate } from '../../lib/core/prediction.ts';
import { explainCandidate, explainWarning, predictLikelyPatient } from '../../lib/core/prediction.ts';
import type { ConfirmationMethod, ScribeSession } from '../../lib/core/session.ts';
import { formatClock, MINUTE_MS } from '../../lib/core/time.ts';
import type { ClinicianEntry, SurgeryEntry } from '../../lib/server/ports.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { useChangeGuard } from '../hooks/useChangeGuard.ts';
import type { DiaryState } from '../hooks/useDiary.ts';
import type { SummaryState } from '../hooks/usePatientSummaries.ts';
import { usePatientSummaries } from '../hooks/usePatientSummaries.ts';
import { DiaryList } from './DiaryList.tsx';
import { Notice } from './Notice.tsx';
import { displayNameFor, PatientCard } from './PatientCard.tsx';

export interface ConfirmedPatientDisplay {
  displayName: string;
  dateOfBirth: string | null;
}

export interface PatientConfirmationProps {
  backend: AppBackend;
  diary: DiaryState & { refresh: () => void };
  now: number;
  timeZone: string;
  clinician: ClinicianEntry;
  surgery: SurgeryEntry | null;
  roomNames: Readonly<Record<string, string>>;
  finishedIds: ReadonlySet<string>;
  onConfirmed: (session: ScribeSession, display: ConfirmedPatientDisplay) => void;
  onOpenExistingSession: () => void;
}

function minutesUntil(ms: number, now: number): number {
  return Math.max(0, Math.ceil((ms - now) / MINUTE_MS));
}

export function PatientConfirmation(p: PatientConfirmationProps) {
  const nowMinute = Math.floor(p.now / MINUTE_MS) * MINUTE_MS;
  const finishedKey = [...p.finishedIds].sort().join('|');

  const prediction = useMemo(
    () =>
      predictLikelyPatient({
        nowMs: nowMinute,
        practitionerId: p.clinician.practitionerId,
        roomId: p.surgery?.roomId ?? null,
        appointments: p.diary.appointments,
        excludeAppointmentIds: finishedKey ? finishedKey.split('|') : [],
      }),
    [nowMinute, p.clinician.practitionerId, p.surgery?.roomId, p.diary.appointments, finishedKey],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const diaryRef = useRef<HTMLOListElement>(null);

  const selected = selectedId ? (p.diary.appointments.find((a) => a.appointmentId === selectedId) ?? null) : null;
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null); // the appointment left the diary on refresh
  }, [selectedId, selected]);

  const topTier: Candidate[] = useMemo(() => {
    const first = prediction.candidates[0];
    return prediction.status === 'AMBIGUOUS' && first ? prediction.candidates.filter((c) => c.tier === first.tier) : [];
  }, [prediction]);

  const shown: DiaryAppointment[] = selected
    ? [selected]
    : prediction.status === 'LIKELY' && prediction.likely
      ? [prediction.likely.appointment]
      : prediction.status === 'AMBIGUOUS'
        ? topTier.map((c) => c.appointment)
        : prediction.nextAppointment
          ? [prediction.nextAppointment]
          : [];

  const summaries = usePatientSummaries(
    p.backend,
    shown.map((a) => a.appointmentId),
    p.diary.lastOkAt,
  );
  const guardKey = `${selected ? 'SELECTED' : prediction.status}:${shown.map((a) => `${a.appointmentId}/${a.patientId}`).join(',')}`;
  const ready = useChangeGuard(guardKey);

  const explainCtx = {
    timeZone: p.timeZone,
    clinicianName: p.clinician.displayName,
    roomNames: p.roomNames,
    selectedRoomId: p.surgery?.roomId ?? null,
  };
  const currentIds = new Set(prediction.candidates.filter((c) => c.tier < 3).map((c) => c.appointment.appointmentId));

  async function confirm(a: DiaryAppointment, method: ConfirmationMethod, predictedAppointmentId: string | null) {
    if (!a.patientId) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await p.backend.confirmPatient({
        appointmentId: a.appointmentId,
        patientId: a.patientId,
        practitionerId: p.clinician.practitionerId,
        surgeryId: p.surgery?.surgeryId ?? null,
        predictedAppointmentId,
        method,
      });
      const summary = summaries.get(a.appointmentId);
      p.onConfirmed(session, {
        displayName: displayNameFor(a, summary),
        dateOfBirth: summary?.status === 'ok' ? summary.data.dateOfBirth : null,
      });
    } catch (err) {
      setError(err instanceof BackendError ? err : new BackendError('UNKNOWN', 'The patient could not be confirmed.'));
      if (err instanceof BackendError && err.code === 'PATIENT_MISMATCH') p.diary.refresh();
    } finally {
      setBusy(false);
    }
  }

  function methodForSelected(a: DiaryAppointment): { method: ConfirmationMethod; predicted: string | null } {
    if (prediction.status === 'LIKELY' && prediction.likely) {
      const likelyId = prediction.likely.appointment.appointmentId;
      return { method: a.appointmentId === likelyId ? 'CONFIRMED_SUGGESTION' : 'CHOSE_ALTERNATIVE', predicted: likelyId };
    }
    if (prediction.status === 'AMBIGUOUS' && topTier.some((c) => c.appointment.appointmentId === a.appointmentId)) {
      return { method: 'RESOLVED_AMBIGUITY', predicted: null };
    }
    return { method: 'CHOSE_FROM_DIARY', predicted: null };
  }

  const focusDiary = () => diaryRef.current?.focus();
  const card = (a: DiaryAppointment, extra: { reasons?: readonly string[]; method: ConfirmationMethod; predicted: string | null; size?: 'large' | 'compact'; children?: ReactNode }) => (
    <PatientCard
      key={a.appointmentId}
      appointment={a}
      summary={summaries.get(a.appointmentId) as SummaryState | undefined}
      timeZone={p.timeZone}
      clinicianName={p.clinician.displayName}
      roomNames={p.roomNames}
      reasons={extra.reasons}
      ready={ready}
      busy={busy}
      size={extra.size}
      onConfirm={() => void confirm(a, extra.method, extra.predicted)}
    >
      {extra.children}
    </PatientCard>
  );

  const offline = p.diary.error !== null && p.diary.appointments.length === 0;

  return (
    <div className="workspace">
      <section className="confirm-panel" aria-live="polite">
        {error && (
          <Notice
            tone="bad"
            title={error.message}
            action={
              error.code === 'ACTIVE_SESSION_EXISTS' ? (
                <button type="button" className="button button-secondary" onClick={p.onOpenExistingSession}>
                  Open that session
                </button>
              ) : undefined
            }
          />
        )}
        {p.diary.error && !offline && (
          <Notice tone="warn" title="Dentally stopped responding">
            The diary below was last updated at {p.diary.lastOkAt ? formatClock(p.diary.lastOkAt, p.timeZone) : 'an earlier time'} and may be out of date.
            Confirming a patient checks with Dentally again.
          </Notice>
        )}

        {offline ? (
          <div className="state-block">
            <h1 className="state-title">Dentally is not responding</h1>
            <p className="state-lead">
              {p.diary.error?.code === 'DENTALLY_AUTH'
                ? p.diary.error.message
                : 'A session cannot start until Dentally is back, because the patient cannot be checked.'}
            </p>
            <div className="actions">
              <button type="button" className="button button-secondary" onClick={p.diary.refresh}>
                Try again
              </button>
            </div>
          </div>
        ) : p.diary.loading && p.diary.appointments.length === 0 ? (
          <div className="state-block">
            <p className="state-lead">Loading today's diary…</p>
          </div>
        ) : selected ? (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">Chosen from today's diary</h1>
              <button type="button" className="link-button" onClick={() => setSelectedId(null)}>
                Back to the suggestion
              </button>
            </div>
            {card(selected, methodForSelected(selected))}
          </div>
        ) : prediction.status === 'LIKELY' && prediction.likely ? (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">Likely current patient</h1>
              <span className={`confidence confidence-${prediction.likely.confidence.toLowerCase()}`}>
                {prediction.likely.confidence === 'HIGH' ? 'High confidence' : 'Medium confidence: check the reasons'}
              </span>
            </div>
            {card(prediction.likely.appointment, {
              reasons: explainCandidate(prediction.likely, explainCtx),
              method: 'CONFIRMED_SUGGESTION',
              predicted: prediction.likely.appointment.appointmentId,
              children: (
                <button type="button" className="button button-secondary" onClick={focusDiary}>
                  Choose another patient
                </button>
              ),
            })}
          </div>
        ) : prediction.status === 'AMBIGUOUS' ? (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">Check who is in the chair</h1>
            </div>
            {prediction.warnings
              .filter((w) => w.code === 'DOUBLE_BOOKED' || w.code === 'PREVIOUS_STILL_IN_SURGERY' || w.code === 'MULTIPLE_CANDIDATES')
              .map((w) => (
                <p key={w.code} className="state-lead">
                  {explainWarning(w)}
                </p>
              ))}
            <div className="candidate-grid">
              {topTier.map((c) =>
                card(c.appointment, { reasons: explainCandidate(c, explainCtx), method: 'RESOLVED_AMBIGUITY', predicted: null, size: 'compact' }),
              )}
            </div>
          </div>
        ) : (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">No appointment for {p.clinician.displayName} right now</h1>
            </div>
            {prediction.nextAppointment ? (
              <>
                <p className="state-lead">
                  Next appointment at {formatClock(prediction.nextAppointment.startMs, p.timeZone)}, in{' '}
                  {minutesUntil(prediction.nextAppointment.startMs, nowMinute)} minutes. Confirm it only if this patient is in the chair now.
                </p>
                {card(prediction.nextAppointment, { method: 'CHOSE_FROM_DIARY', predicted: null })}
              </>
            ) : (
              <p className="state-lead">There are no more appointments today. Choose a patient from the diary if someone is in the chair.</p>
            )}
          </div>
        )}
      </section>

      <DiaryList
        clinicianName={p.clinician.displayName}
        appointments={p.diary.appointments}
        timeZone={p.timeZone}
        roomNames={p.roomNames}
        currentIds={currentIds}
        finishedIds={p.finishedIds}
        selectedId={selectedId}
        onSelect={(a) => setSelectedId(a.appointmentId)}
        loading={p.diary.loading}
        lastOkAt={p.diary.lastOkAt}
        rejectedCount={p.diary.rejectedCount}
        onRefresh={p.diary.refresh}
        listRef={diaryRef}
      />
    </div>
  );
}
