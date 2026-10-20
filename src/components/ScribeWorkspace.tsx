import { useEffect, useRef, useState } from 'react';
import type { ScribeSession } from '../../lib/core/session.ts';
import { formatClock } from '../../lib/core/time.ts';
import type { AppBackend } from '../backend/types.ts';
import type { ListMicrophones, Microphone, StartCapture } from '../scribe/microphone.ts';
import { listMicrophones as defaultListMicrophones, startMicrophone } from '../scribe/microphone.ts';
import type { ConnectTranscriber } from '../scribe/transcriber.ts';
import { connectTranscriber } from '../scribe/transcriber.ts';
import { useNurseNote } from '../scribe/useNurseNote.ts';
import type { TranscriptLine } from '../scribe/useScribe.ts';
import { useScribe } from '../scribe/useScribe.ts';
import { Notice } from './Notice.tsx';

const MIC_KEY = 'auranotetaker.microphone';

function savedMicrophone(): string | null {
  try {
    return localStorage.getItem(MIC_KEY);
  } catch {
    return null;
  }
}

export interface ScribeWorkspaceProps {
  backend: AppBackend;
  session: ScribeSession;
  surgeryId: string;
  timeZone: string;
  /** "Oliver", or "the patient" when the name is not loaded. */
  firstName: string;
  onSessionChange: (s: ScribeSession) => void;
  /** Records the patient's withdrawal (the server deletes everything captured). */
  onWithdraw: () => Promise<void>;
  /** Ends a session before anything is recorded. */
  onCancel: () => void;
  // Injected in tests; real devices otherwise.
  startCapture?: StartCapture;
  listMicrophones?: ListMicrophones;
  connect?: ConnectTranscriber;
}

const SPEAKER_LABEL: Record<string, string> = { S1: 'Speaker 1', S2: 'Speaker 2', S3: 'Speaker 3', S4: 'Speaker 4' };

function TranscriptView({ lines, partial, live }: { lines: TranscriptLine[]; partial: string; live: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [lines.length, partial]);
  if (lines.length === 0 && !partial) {
    return <p className="transcript-empty">{live ? 'Listening… the transcript appears here.' : 'Nothing recorded yet.'}</p>;
  }
  return (
    <div className="transcript-lines">
      {lines.map((l) =>
        l.kind === 'gap' ? (
          <p key={l.key} className="transcript-gap" role="note">
            {l.text}
          </p>
        ) : (
          <p key={l.key} className={`transcript-line ${l.saved ? '' : 'is-unsaved'}`}>
            {l.speaker && <span className="transcript-speaker">{SPEAKER_LABEL[l.speaker] ?? l.speaker}</span>}
            {l.text}
          </p>
        ),
      )}
      {partial && <p className="transcript-partial">{partial}</p>}
      <div ref={end} />
    </div>
  );
}

/**
 * The scribe screen: recording controls, the live transcript and the nurse notes.
 *
 * SAFETY (hazards H02, H03): the recording state is always on screen in words and colour, not colour alone.
 * Nothing is captured until Start is pressed for a patient who agreed. Withdrawal is one step from anywhere
 * and deletes everything for this appointment.
 */
export function ScribeWorkspace(p: ScribeWorkspaceProps) {
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [microphoneId, setMicrophoneId] = useState<string | null>(savedMicrophone);
  const [warning, setWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const listMics = p.listMicrophones ?? defaultListMicrophones;
  const s = p.session;

  const scribe = useScribe({
    backend: p.backend,
    session: s,
    surgeryId: p.surgeryId,
    microphoneId,
    startCapture: p.startCapture ?? startMicrophone,
    connect: p.connect ?? connectTranscriber,
    onSessionChange: p.onSessionChange,
    onWarning: (w) =>
      setWarning(w === 'RETENTION_CLEANUP_FAILED' ? 'Old transcripts past their deletion date could not be deleted. Please tell the practice manager.' : w),
  });
  const notes = useNurseNote({ backend: p.backend, sessionId: s.sessionId, surgeryId: p.surgeryId });
  const { restore } = scribe;
  const { load } = notes;

  // What was saved before this screen opened (after a page reload, or nurse notes typed before recording).
  useEffect(() => {
    let cancelled = false;
    p.backend
      .getScribeContent(s.sessionId, p.surgeryId)
      .then((c) => {
        if (cancelled) return;
        restore(
          c.segments.map((x) => ({ key: x.segmentId, kind: 'speech' as const, speaker: x.speaker, text: x.text, startMs: x.startMs, saved: true })),
          c.segments.reduce((m, x) => Math.max(m, x.seq), 0),
        );
        load(c.nurseNote);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'The transcript so far could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
    // Load once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sessionId]);

  useEffect(() => {
    let cancelled = false;
    listMics()
      .then((m) => !cancelled && setMicrophones(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [listMics, scribe.state.microphoneLabel]);

  const st = scribe.state;
  const capturing = st.phase === 'live' || st.phase === 'reconnecting' || st.phase === 'connecting';
  const serverRecording = s.status === 'RECORDING';
  const statusText =
    st.phase === 'live'
      ? 'Recording'
      : st.phase === 'connecting'
        ? 'Starting…'
        : st.phase === 'reconnecting'
          ? 'Reconnecting'
          : st.phase === 'finishing'
            ? 'Finishing…'
            : serverRecording
              ? 'Not capturing'
              : s.status === 'PAUSED'
                ? 'Paused'
                : s.status === 'STOPPED'
                  ? 'Stopped'
                  : 'Not recording';
  const statusTone = st.phase === 'live' ? 'live' : st.phase === 'reconnecting' || (serverRecording && !capturing) ? 'alert' : 'off';

  async function withdraw() {
    setWithdrawing(true);
    await scribe.abandon();
    notes.load(null);
    try {
      await p.onWithdraw();
    } finally {
      setWithdrawing(false);
      setConfirmWithdraw(false);
    }
  }

  return (
    <div className="scribe">
      <section className={`record-bar record-${statusTone}`} aria-label="Recording">
        <div className="record-status" role="status" aria-live="polite">
          <span className="record-dot" aria-hidden="true" />
          <span className="record-text">{statusText}</span>
          {s.recordingStartedAtMs !== null && <span className="record-since mono-digits">since {formatClock(s.recordingStartedAtMs, p.timeZone)}</span>}
        </div>
        <div className="record-meter" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, st.level) * 100)}%` }} />
        </div>
        <label className="record-mic">
          <span className="visually-hidden">Microphone</span>
          <select
            value={microphoneId ?? ''}
            disabled={capturing || st.busy}
            onChange={(e) => {
              const id = e.target.value || null;
              setMicrophoneId(id);
              try {
                if (id) localStorage.setItem(MIC_KEY, id);
                else localStorage.removeItem(MIC_KEY);
              } catch {
                // Not saved: the choice still applies to this recording.
              }
            }}
          >
            <option value="">Default microphone</option>
            {microphones.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="record-actions">
          {s.status === 'READY' && (
            <button type="button" className="button button-record" disabled={st.busy} onClick={() => void scribe.start()}>
              Start recording
            </button>
          )}
          {serverRecording && !capturing && st.phase !== 'finishing' && (
            <button type="button" className="button button-record" disabled={st.busy} onClick={() => void scribe.start()}>
              Continue recording
            </button>
          )}
          {(s.status === 'PAUSED' || s.status === 'STOPPED') && (
            <button type="button" className="button button-record" disabled={st.busy} onClick={() => void scribe.start()}>
              Resume recording
            </button>
          )}
          {serverRecording && (
            <>
              <button type="button" className="button button-secondary" disabled={st.busy} onClick={() => void scribe.pause()}>
                Pause
              </button>
              <button type="button" className="button button-secondary" disabled={st.busy} onClick={() => void scribe.stop()}>
                Stop
              </button>
            </>
          )}
          {s.status === 'PAUSED' && (
            <button type="button" className="button button-secondary" disabled={st.busy} onClick={() => void scribe.stop()}>
              Stop
            </button>
          )}
        </div>
      </section>

      {st.problem && <Notice tone={statusTone === 'alert' ? 'bad' : 'warn'} title={st.problem} />}
      {st.saveProblem && <Notice tone="bad" title={st.saveProblem} />}
      {loadError && <Notice tone="bad" title={loadError} />}
      {warning && <Notice tone="warn" title={warning} />}
      {s.status === 'STOPPED' && (
        <Notice tone="info" title="Recording stopped.">
          Drafting the clinical note from this transcript arrives in the next phase of the build. You can resume recording if the appointment carries on.
        </Notice>
      )}

      <div className="scribe-columns">
        <section className="scribe-panel" aria-labelledby="transcript-heading">
          <div className="scribe-panel-head">
            <h2 id="transcript-heading">Transcript</h2>
            {st.unsaved > 0 && <span className="tag tag-warn">{st.unsaved} not saved yet</span>}
          </div>
          <div className="transcript" aria-live="off">
            <TranscriptView lines={st.lines} partial={st.partial} live={capturing} />
          </div>
        </section>
        <section className="scribe-panel" aria-labelledby="notes-heading">
          <div className="scribe-panel-head">
            <h2 id="notes-heading">Nurse notes</h2>
            <span className={`save-state save-${notes.status}`}>
              {notes.status === 'loading'
                ? 'Loading…'
                : notes.status === 'saving'
                  ? 'Saving…'
                  : notes.status === 'unsaved'
                    ? 'Not saved yet'
                    : notes.status === 'saved'
                      ? 'Saved'
                      : 'Not saved'}
            </span>
          </div>
          <textarea
            className="nurse-notes"
            aria-labelledby="notes-heading"
            value={notes.text}
            disabled={notes.status === 'loading' || notes.status === 'conflict' || withdrawing}
            placeholder="Shade, materials, batch numbers, anything said off-mic…"
            onChange={(e) => notes.setText(e.target.value)}
          />
          {notes.message && <Notice tone="bad" title={notes.message} />}
        </section>
      </div>

      <div className="scribe-foot">
        {s.status === 'READY' && (
          <button type="button" className="link-button" disabled={st.busy} onClick={p.onCancel}>
            End session without recording
          </button>
        )}
        {!confirmWithdraw ? (
          <button type="button" className="link-button link-danger" disabled={st.busy || withdrawing} onClick={() => setConfirmWithdraw(true)}>
            {p.firstName === 'the patient' ? 'The patient' : p.firstName} has withdrawn permission
          </button>
        ) : (
          <div className="withdraw-confirm" role="group" aria-label="Confirm withdrawal">
            <p>
              This stops recording now and deletes the transcript and nurse notes for this appointment. Nothing will be sent for AI processing.
            </p>
            <div className="actions">
              <button type="button" className="button button-danger" disabled={withdrawing} onClick={() => void withdraw()}>
                Stop and delete everything
              </button>
              <button type="button" className="button button-secondary" disabled={withdrawing} onClick={() => setConfirmWithdraw(false)}>
                Keep going
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
