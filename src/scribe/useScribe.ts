// Runs a recording: microphone, live speech-to-text, and saving finished transcript to the backend.
//
// SAFETY (hazards H02, H03, H10, H12, H19):
// - Audio flows only while the server says the session is RECORDING. Start, pause, resume and stop go to
//   the server first; the microphone opens only after the server accepted. Anything still opening when the
//   recording is paused or stopped is shut, never left running (the `generation` counter).
// - Every failure is shown and recorded. Where speech may be missing (a dropped connection, a microphone
//   that went quiet or stopped, a reload, an unconfirmed end) a GAP line is added and saved with the
//   transcript, so the note step and the reviewer see it too.
// - Withdrawn permission stops capture at once and holds back unsaved lines; they are dropped only once
//   the server has recorded the withdrawal (it deletes everything already saved).
// - Transcript text is held in memory only, never in browser storage.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScribeSession } from '../../lib/core/session.ts';
import type { TranscriptSegmentInput } from '../../lib/core/transcript.ts';
import { MAX_SEGMENTS_PER_SAVE } from '../../lib/core/transcript.ts';
import type { RecordingAction } from '../../lib/server/handlers.ts';
import type { SpeechPiece } from '../../lib/speech/speechmatics.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import type { CaptureHandle, StartCapture } from './microphone.ts';
import { MicrophoneError } from './microphone.ts';
import { resetPendingSaves, setTranscriptPending } from './pendingSaves.ts';
import type { ConnectTranscriber, Transcriber } from './transcriber.ts';

export type ScribePhase =
  /** Not recording on this screen. */
  | 'idle'
  /** Opening the microphone and speech-to-text. */
  | 'connecting'
  | 'live'
  /** Speech-to-text dropped; trying again. The microphone is still on, but speech in this gap is lost. */
  | 'reconnecting'
  /** The server says recording, but nothing is capturing here (page reloaded, or capture failed). */
  | 'interrupted'
  /** Finishing the last transcript before pausing or stopping. */
  | 'finishing';

export interface TranscriptLine {
  key: string;
  kind: 'speech' | 'gap';
  speaker: string | null;
  text: string;
  startMs: number;
  endMs: number;
  saved: boolean;
}

export interface ScribeState {
  phase: ScribePhase;
  lines: TranscriptLine[];
  partial: string;
  level: number;
  /** No sound has reached the screen from the microphone for a few seconds while recording. */
  silentMicrophone: boolean;
  /** Lines finished but not yet confirmed saved by the server. */
  unsaved: number;
  /** Shown above the controls. Null when all is well. */
  problem: string | null;
  /** Shown while saving keeps failing. */
  saveProblem: string | null;
  busy: boolean;
  microphoneLabel: string | null;
  /** The transcript saved earlier has been loaded. Recording waits for it so line order stays right. */
  restored: boolean;
}

export interface UseScribeOptions {
  backend: AppBackend;
  session: ScribeSession;
  surgeryId: string;
  microphoneId: string | null;
  startCapture: StartCapture;
  connect: ConnectTranscriber;
  onSessionChange: (s: ScribeSession) => void;
  /** Called with a retention warning from the server, if any. */
  onWarning?: (warning: string) => void;
  /** Injected in tests. */
  now?: () => number;
}

const SAVE_EVERY_MS = 2_500;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 8_000];
const MS_PER_SAMPLE = 1000 / 16_000;
/** No audio for this long while recording counts as a stalled microphone. */
const SILENT_AFTER_MS = 3_000;

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `seg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

function describeSpeechError(reason: string): string {
  if (reason === 'not_authorised') return 'The speech-to-text service refused the connection. Please tell the practice manager.';
  if (reason === 'quota_exceeded') return 'The speech-to-text account has reached its limit. Please tell the practice manager.';
  return 'The connection to speech-to-text dropped.';
}

const seconds = (ms: number) => `about ${Math.max(1, Math.round(ms / 1000))} s`;

export function useScribe(o: UseScribeOptions) {
  const now = o.now ?? Date.now;
  const alive = useRef(true);
  const [state, setState] = useState<ScribeState>({
    phase: o.session.status === 'RECORDING' ? 'interrupted' : 'idle',
    lines: [],
    partial: '',
    level: 0,
    silentMicrophone: false,
    unsaved: 0,
    problem: o.session.status === 'RECORDING' ? 'Recording was interrupted on this screen (the page was reloaded). Nothing is being captured.' : null,
    saveProblem: null,
    busy: false,
    microphoneLabel: null,
    restored: false,
  });
  const patch = useCallback((p: Partial<ScribeState> | ((s: ScribeState) => Partial<ScribeState>)) => {
    if (!alive.current) return;
    setState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
  }, []);

  const optsRef = useRef(o);
  optsRef.current = o;
  const sessionRef = useRef(o.session);
  sessionRef.current = o.session;
  const nowRef = useRef(now);
  nowRef.current = now;

  const capture = useRef<CaptureHandle | null>(null);
  const transcriber = useRef<Transcriber | null>(null);
  /** Bumped whenever capture stops, so anything still opening knows it has been overtaken. */
  const generation = useRef(0);
  /** Audio captured on this screen since recording began, in ms. Speech-to-text times count from each connection. */
  const capturedMs = useRef(0);
  const seq = useRef(0);
  const lastEndMs = useRef(0);
  const outbox = useRef<TranscriptSegmentInput[]>([]);
  /** While permission is being withdrawn nothing more is sent. */
  const withheld = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall-clock time speech-to-text was lost, while reconnecting. */
  const droppedAt = useRef<number | null>(null);
  const lastAudioAt = useRef(0);
  const silentSince = useRef<number | null>(null);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);

  // ---- saving -------------------------------------------------------------

  const flushOnce = useCallback(async (): Promise<boolean> => {
    const batch = outbox.current.slice(0, MAX_SEGMENTS_PER_SAVE);
    if (batch.length === 0 || withheld.current) return outbox.current.length === 0;
    try {
      const s = sessionRef.current;
      await optsRef.current.backend.saveTranscript(s.sessionId, optsRef.current.surgeryId, batch);
      const savedIds = new Set(batch.map((b) => b.segmentId));
      outbox.current = outbox.current.filter((b) => !savedIds.has(b.segmentId));
      patch((st) => ({
        lines: st.lines.map((l) => (savedIds.has(l.key) ? { ...l, saved: true } : l)),
        unsaved: outbox.current.length,
        saveProblem: null,
      }));
      return outbox.current.length === 0;
    } catch (err) {
      const refused = err instanceof BackendError && (err.code === 'SESSION_TRANSITION_REFUSED' || err.code === 'FORBIDDEN' || err.code === 'VALIDATION');
      patch({
        unsaved: outbox.current.length,
        saveProblem: refused
          ? `The transcript could not be saved: ${err instanceof Error ? err.message : 'refused'}`
          : `${outbox.current.length} transcript line${outbox.current.length === 1 ? '' : 's'} not saved yet. Retrying. Keep this page open.`,
      });
      return false;
    }
  }, [patch]);

  /** Saves what is waiting. Only one save runs at a time; callers can wait for it. */
  const flush = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const p = flushOnce().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  }, [flushOnce]);

  useEffect(() => {
    const t = setInterval(() => {
      if (outbox.current.length > 0) void flush();
    }, SAVE_EVERY_MS);
    return () => clearInterval(t);
  }, [flush]);

  // ---- transcript lines ---------------------------------------------------

  const queue = useCallback(
    (segs: TranscriptSegmentInput[]) => {
      if (segs.length === 0) return;
      outbox.current.push(...segs);
      for (const x of segs) lastEndMs.current = Math.max(lastEndMs.current, x.endMs);
      patch((st) => ({
        lines: [
          ...st.lines,
          ...segs.map((x) => ({
            key: x.segmentId,
            kind: x.kind === 'GAP' ? ('gap' as const) : ('speech' as const),
            speaker: x.speaker,
            text: x.text,
            startMs: x.startMs,
            endMs: x.endMs,
            saved: false,
          })),
        ],
        unsaved: outbox.current.length,
      }));
    },
    [patch],
  );

  const addPieces = useCallback(
    (pieces: SpeechPiece[], baseMs: number) => {
      queue(
        pieces.map((p) => {
          const startMs = Math.max(0, Math.round(baseMs + p.startS * 1000));
          return {
            kind: 'SPEECH' as const,
            segmentId: newId(),
            seq: (seq.current += 1),
            startMs,
            endMs: Math.max(startMs, Math.round(baseMs + p.endS * 1000)),
            speaker: p.speaker,
            text: p.text,
          };
        }),
      );
    },
    [queue],
  );

  /** Records that speech may be missing at this point in the recording. */
  const addGap = useCallback(
    (why: string, durationMs: number | null = null) => {
      const at = Math.max(Math.round(capturedMs.current), lastEndMs.current);
      queue([
        {
          kind: 'GAP',
          segmentId: newId(),
          seq: (seq.current += 1),
          startMs: at,
          endMs: at,
          speaker: null,
          text: `Speech may be missing here: ${why}${durationMs !== null ? ` (${seconds(durationMs)})` : ''}.`,
        },
      ]);
    },
    [queue],
  );

  // ---- devices ------------------------------------------------------------

  const releaseWakeLock = () => {
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  };

  const acquireWakeLock = async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      wakeLock.current = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Not supported or refused: the device policy must keep the PC awake (docs/deployment.md).
    }
  };

  /** Stops capture. Returns false when the last words could not be confirmed as transcribed. */
  const stopDevices = useCallback(
    async (mode: 'finish' | 'drop'): Promise<boolean> => {
      generation.current += 1;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      const t = transcriber.current;
      transcriber.current = null;
      let complete = true;
      if (t) {
        if (mode === 'finish') complete = await t.finish();
        else t.close();
      }
      const c = capture.current;
      capture.current = null;
      await c?.stop();
      releaseWakeLock();
      silentSince.current = null;
      patch({ level: 0, partial: '', silentMicrophone: false });
      return complete;
    },
    [patch],
  );

  // Forward reference: openStream and scheduleReconnect call each other.
  const openStreamRef = useRef<() => Promise<boolean>>(async () => false);

  const scheduleReconnect = useCallback(
    (reason: string, retryable: boolean) => {
      transcriber.current = null;
      if (droppedAt.current === null) droppedAt.current = nowRef.current();
      const attempt = reconnectAttempt.current;
      if (!retryable || attempt >= RECONNECT_DELAYS_MS.length) {
        void (async () => {
          await stopDevices('drop');
          if (droppedAt.current !== null) addGap('the speech-to-text connection was lost', nowRef.current() - droppedAt.current);
          droppedAt.current = null;
          patch({
            phase: 'interrupted',
            problem: `${describeSpeechError(reason)} Nothing is being captured. Check the internet connection, then continue recording.`,
          });
        })();
        return;
      }
      reconnectAttempt.current = attempt + 1;
      const gen = generation.current;
      patch({ phase: 'reconnecting', partial: '', problem: `${describeSpeechError(reason)} Reconnecting… speech during this gap is not being transcribed.` });
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        // Paused, stopped or withdrawn in the meantime: do not reopen anything.
        if (gen !== generation.current || !alive.current) return;
        void openStreamRef.current();
      }, RECONNECT_DELAYS_MS[attempt]);
    },
    [addGap, patch, stopDevices],
  );

  /** Opens the microphone (if not open) and a speech-to-text connection. Assumes the server says RECORDING. */
  const openStream = useCallback(async (): Promise<boolean> => {
    const { backend, surgeryId, microphoneId, startCapture, connect } = optsRef.current;
    const s = sessionRef.current;
    const gen = generation.current;
    const overtaken = () => gen !== generation.current || !alive.current;
    if (!capture.current) {
      try {
        const handle = await startCapture(microphoneId, {
          onAudio: (pcm) => {
            capturedMs.current += pcm.length * MS_PER_SAMPLE;
            lastAudioAt.current = nowRef.current();
            transcriber.current?.sendAudio(pcm);
          },
          onLevel: (level) => patch({ level }),
          onEnded: () => {
            if (gen !== generation.current) return;
            void (async () => {
              const complete = await stopDevices('finish');
              addGap(complete ? 'the microphone stopped' : 'the microphone stopped and the last words were not confirmed');
              void flush();
              patch({ phase: 'interrupted', problem: 'The microphone stopped (unplugged or taken by another program). Nothing is being captured. Check it, then continue recording.' });
            })();
          },
        });
        if (overtaken()) {
          await handle.stop();
          return false;
        }
        capture.current = handle;
        lastAudioAt.current = nowRef.current();
        patch({ microphoneLabel: handle.label });
      } catch (err) {
        if (overtaken()) return false;
        patch({ phase: 'interrupted', problem: err instanceof MicrophoneError ? err.message : 'The microphone could not be started.' });
        return false;
      }
      await acquireWakeLock();
      if (overtaken()) return false;
    }
    let token;
    try {
      token = await backend.getSpeechToken(s.sessionId, surgeryId);
    } catch (err) {
      if (overtaken()) return false;
      const retryable = !(err instanceof BackendError) || err.code === 'SPEECH_UNAVAILABLE' || err.code === 'NETWORK' || err.code === 'TIMEOUT';
      if (!retryable) {
        await stopDevices('drop');
        patch({ phase: 'interrupted', problem: err instanceof Error ? err.message : 'Speech-to-text could not start.' });
        return false;
      }
      scheduleReconnect('token_failed', true);
      return false;
    }
    if (overtaken()) return false;
    const baseMs = capturedMs.current;
    let me: Transcriber | null = null;
    const current = () => me !== null && transcriber.current === me;
    try {
      me = connect(token, {
        onReady: () => {
          if (!current()) return;
          reconnectAttempt.current = 0;
          if (droppedAt.current !== null) {
            addGap('the speech-to-text connection dropped', nowRef.current() - droppedAt.current);
            droppedAt.current = null;
          }
          patch({ phase: 'live', problem: null });
        },
        onPartial: (text) => {
          if (current()) patch({ partial: text });
        },
        // Finished speech from a connection that is closing (pause, stop) is still this recording's.
        onFinal: (pieces) => addPieces(pieces, baseMs),
        onError: (reason, retryable) => {
          if (current()) scheduleReconnect(reason, retryable);
        },
      });
      transcriber.current = me;
    } catch {
      scheduleReconnect('connection_failed', true);
      return false;
    }
    return true;
  }, [addGap, addPieces, flush, patch, scheduleReconnect, stopDevices]);
  openStreamRef.current = openStream;

  // A microphone that goes quiet (muted, suspended, asleep) is not the same as silence in the room:
  // silence still delivers audio. No audio at all for a few seconds is a fault, shown and marked.
  useEffect(() => {
    const t = setInterval(() => {
      if (!capture.current) return;
      const quietFor = nowRef.current() - lastAudioAt.current;
      if (quietFor > SILENT_AFTER_MS && silentSince.current === null) {
        silentSince.current = lastAudioAt.current;
        patch({ silentMicrophone: true, problem: 'No sound is reaching AuraNoteTaker from the microphone. Check it is not muted or unplugged.' });
      } else if (quietFor <= SILENT_AFTER_MS && silentSince.current !== null) {
        addGap('no sound reached AuraNoteTaker from the microphone', nowRef.current() - silentSince.current);
        silentSince.current = null;
        patch({ silentMicrophone: false, problem: null });
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [addGap, patch]);

  // The browser drops the screen wake lock when the tab is hidden; take it again on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && capture.current && !wakeLock.current) void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // ---- actions ------------------------------------------------------------

  const serverAction = useCallback(
    async (action: RecordingAction): Promise<boolean> => {
      const s = sessionRef.current;
      const { backend, surgeryId, onSessionChange, onWarning } = optsRef.current;
      try {
        const res = await backend.changeRecording(s.sessionId, surgeryId, action, s.version);
        sessionRef.current = res.session;
        onSessionChange(res.session);
        if (res.warning) onWarning?.(res.warning);
        return true;
      } catch (err) {
        patch({ problem: err instanceof Error ? err.message : 'That did not work. Try again.' });
        return false;
      }
    },
    [patch],
  );

  /** Start (from READY), resume (from PAUSED or STOPPED), or continue after an interruption (already RECORDING). */
  const start = useCallback(async () => {
    if (!state.restored) return;
    patch({ busy: true, problem: null, phase: 'connecting' });
    const status = sessionRef.current.status;
    let ok = true;
    if (status === 'READY') ok = await serverAction('START');
    else if (status === 'PAUSED' || status === 'STOPPED') ok = await serverAction('RESUME');
    if (ok) {
      reconnectAttempt.current = 0;
      droppedAt.current = null;
      if (capturedMs.current < lastEndMs.current) {
        // After a reload this screen's audio clock starts at zero: carry on after the saved lines.
        capturedMs.current = lastEndMs.current + 1000;
        if (status === 'RECORDING') addGap('recording was interrupted (the page was reloaded)');
      }
      ok = await openStream();
    }
    patch((st) => ({
      busy: false,
      phase: !ok && st.phase === 'connecting' ? (sessionRef.current.status === 'RECORDING' ? 'interrupted' : 'idle') : st.phase,
    }));
  }, [addGap, openStream, patch, serverAction, state.restored]);

  const pauseOrStop = useCallback(
    async (action: 'PAUSE' | 'STOP') => {
      patch({ busy: true, phase: 'finishing', problem: null });
      const complete = await stopDevices('finish');
      if (droppedAt.current !== null) {
        addGap('the speech-to-text connection dropped', nowRef.current() - droppedAt.current);
        droppedAt.current = null;
      }
      if (!complete) addGap('the last words before the pause were not confirmed as transcribed');
      const ok = await serverAction(action);
      await flush();
      patch({ busy: false, phase: ok ? 'idle' : 'interrupted' });
    },
    [addGap, flush, patch, serverAction, stopDevices],
  );

  /**
   * The patient withdrew permission. Stops capture at once and waits for any save already under way,
   * so nothing reaches the server after the withdrawal. Unsaved lines are held, not sent.
   */
  const prepareWithdrawal = useCallback(async () => {
    withheld.current = true;
    await stopDevices('drop');
    await inFlight.current?.catch(() => false);
    patch({ phase: 'idle' });
  }, [patch, stopDevices]);

  /** The server recorded the withdrawal: drop everything held here. */
  const completeWithdrawal = useCallback(() => {
    outbox.current = [];
    patch({ lines: [], partial: '', unsaved: 0, saveProblem: null, problem: null });
  }, [patch]);

  /** The withdrawal did not go through: carry on saving as before. */
  const cancelWithdrawal = useCallback(() => {
    withheld.current = false;
    patch({ phase: sessionRef.current.status === 'RECORDING' ? 'interrupted' : 'idle' });
  }, [patch]);

  /** Loads what was saved before (after a page reload). Recording is only offered after this. */
  const restore = useCallback(
    (lines: TranscriptLine[], maxSeq: number) => {
      seq.current = Math.max(seq.current, maxSeq);
      lastEndMs.current = Math.max(lastEndMs.current, 0, ...lines.map((l) => l.endMs));
      patch((st) => {
        const have = new Set(st.lines.map((l) => l.key));
        return { lines: [...lines.filter((l) => !have.has(l.key)), ...st.lines], restored: true };
      });
    },
    [patch],
  );

  // Tell the note writer what is still waiting to be saved, so it does not draft from part of the appointment.
  useEffect(() => {
    setTranscriptPending(state.unsaved + (inFlight.current ? 1 : 0), seq.current);
  }, [state.unsaved, state.lines.length]);
  useEffect(() => () => resetPendingSaves(), []);

  // Unsaved transcript or a live microphone: ask before the page is closed.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (capture.current || outbox.current.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void stopDevices('drop');
      // Leaving the screen: still try to save what was finished (unless permission is being withdrawn).
      void flush();
    };
  }, [flush, stopDevices]);

  return {
    state,
    start,
    pause: () => pauseOrStop('PAUSE'),
    stop: () => pauseOrStop('STOP'),
    prepareWithdrawal,
    completeWithdrawal,
    cancelWithdrawal,
    restore,
    flush,
  };
}
