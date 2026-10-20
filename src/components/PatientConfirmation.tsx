import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiaryAppointment } from '../../lib/core/appointments.ts';
import type { PredictionWarning } from '../../lib/core/prediction.ts';
import { explainCandidate, explainWarning, predictLikelyPatient } from '../../lib/core/prediction.ts';
import type { ConfirmationMethod, ScribeSession } from '../../lib/core/session.ts';
import { formatClock, MINUTE_MS } from '../../lib/core/time.ts';
import type { PatientSummary } from '../../lib/dentally/types.ts';
import type { ScribeOutcome } from '../../lib/server/handlers.ts';
import type { ClinicianEntry, SurgeryEntry } from '../../lib/server/ports.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { useChangeGuard } from '../hooks/useChangeGuard.ts';
import type { DiaryState } from '../hooks/useDiary.ts';
import type { SummaryRequest } from '../hooks/usePatientSummaries.ts';
import { summaryKey, usePatientSummaries } from '../hooks/usePatientSummaries.ts';
import { DiaryList } from './DiaryList.tsx';
import { Notice } from './Notice.tsx';
import { PatientCard } from './PatientCard.tsx';

export interface PatientConfirmationProps {
  backend: AppBackend;
  diary: DiaryState & { refresh: () => void };
  /** The time now, corrected to the server's clock (see useDiary clockOffsetMs). */
  now: number;
  timeZone: string;
  clinician: ClinicianEntry;
  /** The surgery this computer is in. Every session belongs to one. */
  surgery: SurgeryEntry;
  roomNames: Readonly<Record<string, string>>;
  /** Appointments already finished with in AuraNoteTaker today. They are never suggested again. */
  outcomes: Readonly<Record<string, ScribeOutcome>>;
  /** Called with the identity the server verified and locked to the new session. */
  onConfirmed: (session: ScribeSession, patient: PatientSummary) => void;
  onOpenExistingSession: () => void;
}

interface Attempt {
  appointment: DiaryAppointment;
  method: ConfirmationMethod;
  predicted: string | null;
}

/** Errors after which the diary on screen is probably out of date. */
const REFRESH_AFTER = new Set(['PATIENT_MISMATCH', 'NOT_FOUND', 'APPOINTMENT_CLOSED', 'PRACTITIONER_MISMATCH']);

function minutesUntil(ms: number, now: number): number {
  return Math.max(0, Math.ceil((ms - now) / MINUTE_MS));
}

/**
 * Suggests who is in the chair and asks a person to confirm it.
 *
 * SAFETY (hazard H01): the prediction only chooses which card to show. Nothing happens until someone
 * presses a confirm button that names the patient, and the server then checks the appointment and the
 * patient with Dentally again before it creates a session.
 */
export function PatientConfirmation(p: PatientConfirmationProps) {
  const nowMinute = Math.floor(p.now / MINUTE_MS) * MINUTE_MS;
  const outcomeKey = Object.keys(p.outcomes).sort().join('|');

  const prediction = useMemo(
    () =>
      predictLikelyPatient({
        nowMs: nowMinute,
        practitionerId: p.clinician.practitionerId,
        roomId: p.surgery.roomId,
        appointments: p.diary.appointments,
        excludeAppointmentIds: outcomeKey ? outcomeKey.split('|') : [],
        options: p.diary.predictionOptions,
      }),
    [nowMinute, p.clinician.practitionerId, p.surgery.roomId, p.diary.appointments, outcomeKey, p.diary.predictionOptions],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const [lastAttempt, setLastAttempt] = useState<Attempt | null>(null);
  const diaryRef = useRef<HTMLOListElement>(null);

  // Dentally returned two different bookings under these IDs: they are shown in the diary but cannot be chosen.
  const conflictingKey = prediction.warnings
    .filter((w) => w.code === 'CONFLICTING_DUPLICATE')
    .flatMap((w) => w.appointmentIds)
    .sort()
    .join('|');
  const conflictingIds = useMemo(() => new Set(conflictingKey ? conflictingKey.split('|') : []), [conflictingKey]);
  const selected =
    selectedId && !conflictingIds.has(selectedId) ? (p.diary.appointments.find((a) => a.appointmentId === selectedId) ?? null) : null;
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null); // the appointment left the diary on refresh
  }, [selectedId, selected]);

  const shown: DiaryAppointment[] = selected
    ? [selected]
    : prediction.status === 'LIKELY' && prediction.likely
      ? [prediction.likely.appointment]
      : prediction.status === 'AMBIGUOUS'
        ? prediction.choices.map((c) => c.appointment)
        : prediction.nextAppointment
          ? [prediction.nextAppointment]
          : [];

  // Name and date of birth for exactly the appointment and patient each card shows.
  const requests: SummaryRequest[] = shown.flatMap((a) => (a.patientId ? [{ appointmentId: a.appointmentId, patientId: a.patientId }] : []));
  const summaries = usePatientSummaries(p.backend, requests, p.diary.lastOkAt);
  const summaryFor = (a: DiaryAppointment) => (a.patientId ? summaries.get(summaryKey({ appointmentId: a.appointmentId, patientId: a.patientId })) : undefined);

  // Dentally says an appointment now belongs to someone else: fetch the diary again, once per change.
  const refreshedFor = useRef(new Set<string>());
  const requestKey = requests.map(summaryKey).join('|');
  const { refresh } = p.diary;
  useEffect(() => {
    const mismatched = (requestKey ? requestKey.split('|') : []).filter(
      (k) => summaries.get(k)?.status === 'mismatch' && !refreshedFor.current.has(k),
    );
    if (mismatched.length === 0) return;
    for (const k of mismatched) refreshedFor.current.add(k);
    refresh();
  }, [summaries, requestKey, refresh]);

  const guardKey = `${selected ? 'SELECTED' : prediction.status}:${shown.map((a) => `${a.appointmentId}/${a.patientId}`).join(',')}`;
  const ready = useChangeGuard(guardKey);

  const explainCtx = {
    timeZone: p.timeZone,
    clinicianName: p.clinician.displayName,
    roomNames: p.roomNames,
    selectedRoomId: p.surgery.roomId,
  };
  const warningText = (w: PredictionWarning) => explainWarning(w, { timeZone: p.timeZone, appointments: p.diary.appointments });
  const currentIds = new Set(prediction.candidates.filter((c) => c.tier < 3).map((c) => c.appointment.appointmentId));

  async function confirm(attempt: Attempt, acknowledgePreviousDecline = false) {
    const a = attempt.appointment;
    if (!a.patientId) return;
    setBusy(true);
    setError(null);
    setLastAttempt(attempt);
    try {
      const { session, patient } = await p.backend.confirmPatient({
        appointmentId: a.appointmentId,
        patientId: a.patientId,
        practitionerId: p.clinician.practitionerId,
        surgeryId: p.surgery.surgeryId,
        predictedAppointmentId: attempt.predicted,
        method: attempt.method,
        ...(acknowledgePreviousDecline ? { acknowledgePreviousDecline: true } : {}),
      });
      p.onConfirmed(session, patient);
    } catch (err) {
      const e = err instanceof BackendError ? err : new BackendError('UNKNOWN', 'The patient could not be confirmed.');
      setError(e);
      if (REFRESH_AFTER.has(e.code)) p.diary.refresh();
    } finally {
      setBusy(false);
    }
  }

  function attemptFor(a: DiaryAppointment): Attempt {
    if (prediction.status === 'LIKELY' && prediction.likely) {
      const likelyId = prediction.likely.appointment.appointmentId;
      return { appointment: a, method: a.appointmentId === likelyId ? 'CONFIRMED_SUGGESTION' : 'CHOSE_ALTERNATIVE', predicted: likelyId };
    }
    if (prediction.status === 'AMBIGUOUS' && prediction.choices.some((c) => c.appointment.appointmentId === a.appointmentId)) {
      return { appointment: a, method: 'RESOLVED_AMBIGUITY', predicted: null };
    }
    return { appointment: a, method: 'CHOSE_FROM_DIARY', predicted: null };
  }

  // The earlier-decline question applies only while that same patient is still on screen.
  const declineRetry =
    error?.code === 'PREVIOUS_DECLINE' && lastAttempt && shown.some((a) => a.appointmentId === lastAttempt.appointment.appointmentId && a.patientId === lastAttempt.appointment.patientId)
      ? lastAttempt
      : null;

  const focusDiary = () => diaryRef.current?.focus();
  const card = (
    a: DiaryAppointment,
    extra: { attempt: Attempt; reasons?: readonly string[]; size?: 'large' | 'compact'; children?: ReactNode },
  ) => (
    <PatientCard
      key={a.appointmentId}
      appointment={a}
      summary={summaryFor(a)}
      timeZone={p.timeZone}
      clinicianName={p.clinician.displayName}
      roomNames={p.roomNames}
      reasons={extra.reasons}
      ready={ready}
      busy={busy}
      size={extra.size}
      onConfirm={() => void confirm(extra.attempt)}
      onRetry={p.diary.refresh}
    >
      {extra.children}
    </PatientCard>
  );

  const warningNotice = (warnings: readonly PredictionWarning[], title: string) =>
    warnings.length > 0 ? (
      <Notice tone="warn" title={title}>
        <ul className="warning-list">
          {warnings.map((w) => (
            <li key={w.code}>{warningText(w)}</li>
          ))}
        </ul>
      </Notice>
    ) : null;

  const offline = p.diary.error !== null && p.diary.appointments.length === 0;

  return (
    <div className="workspace">
      <section className="confirm-panel" aria-live="polite">
        {error && (
          <Notice
            tone={error.code === 'PREVIOUS_DECLINE' ? 'warn' : 'bad'}
            title={error.message}
            action={
              error.code === 'ACTIVE_SESSION_EXISTS' ? (
                <button type="button" className="button button-secondary" onClick={p.onOpenExistingSession}>
                  Open that session
                </button>
              ) : declineRetry ? (
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => void confirm(declineRetry, true)}>
                  The patient has changed their mind
                </button>
              ) : undefined
            }
          />
        )}
        {p.diary.error && !offline && (
          <Notice tone="warn" title="Dentally stopped responding">
            The diary below was last updated at {p.diary.lastOkAt ? formatClock(p.diary.lastOkAt + (p.diary.clockOffsetMs ?? 0), p.timeZone) : 'an earlier time'} and
            may be out of date. Confirming a patient checks with Dentally again.
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
            {warningNotice(
              prediction.warnings.filter((w) => w.appointmentIds.includes(selected.appointmentId)),
              'Check before confirming',
            )}
            {card(selected, { attempt: attemptFor(selected) })}
          </div>
        ) : prediction.status === 'LIKELY' && prediction.likely ? (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">Likely current patient</h1>
              <span className={`confidence confidence-${prediction.likely.confidence.toLowerCase()}`}>
                {prediction.likely.confidence === 'HIGH' ? 'High confidence' : 'Medium confidence: check the reasons'}
              </span>
            </div>
            {warningNotice(prediction.warnings, 'Check before confirming')}
            {card(prediction.likely.appointment, {
              attempt: attemptFor(prediction.likely.appointment),
              reasons: explainCandidate(prediction.likely, explainCtx),
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
            {prediction.warnings.map((w) => (
              <p key={w.code} className="state-lead">
                {warningText(w)}
              </p>
            ))}
            <div className={prediction.choices.length > 1 ? 'candidate-grid' : undefined}>
              {prediction.choices.map((c) =>
                card(c.appointment, {
                  attempt: attemptFor(c.appointment),
                  reasons: explainCandidate(c, explainCtx),
                  size: prediction.choices.length > 1 ? 'compact' : 'large',
                }),
              )}
            </div>
          </div>
        ) : (
          <div className="state-block">
            <div className="state-heading">
              <h1 className="state-title">No appointment for {p.clinician.displayName} right now</h1>
            </div>
            {warningNotice(prediction.warnings, 'Check the diary')}
            {prediction.nextAppointment ? (
              <>
                <p className="state-lead">
                  Next appointment at {formatClock(prediction.nextAppointment.startMs, p.timeZone)}, in{' '}
                  {minutesUntil(prediction.nextAppointment.startMs, nowMinute)} minutes. Confirm it only if this patient is in the chair now.
                </p>
                {card(prediction.nextAppointment, { attempt: attemptFor(prediction.nextAppointment) })}
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
        outcomes={p.outcomes}
        conflictingIds={conflictingIds}
        selectedId={selectedId}
        onSelect={(a) => setSelectedId(a.appointmentId)}
        loading={p.diary.loading}
        lastOkAt={p.diary.lastOkAt === null ? null : p.diary.lastOkAt + (p.diary.clockOffsetMs ?? 0)}
        rejectedCount={p.diary.rejectedCount}
        onRefresh={p.diary.refresh}
        listRef={diaryRef}
      />
    </div>
  );
}
