// Runs a recording: microphone, live speech-to-text, and saving finished transcript to the backend.
//
// SAFETY (hazards H02, H03, H12):
// - Audio flows only while the server says the session is RECORDING. Start, pause, resume and stop go to
//   the server first; the microphone opens only after the server accepted.
// - Every failure is shown: a lost connection, a microphone that stops, transcript not yet saved. Speech
//   that may have been missed is marked in the transcript, never papered over.
// - Withdrawn permission closes everything at once and drops anything unsaved (the server deletes the rest).
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
  saved: boolean;
}

export interface ScribeState {
  phase: ScribePhase;
  lines: TranscriptLine[];
  partial: string;
  level: number;
  /** Lines finished but not yet confirmed saved by the server. */
  unsaved: number;
  /** Shown above the controls. Null when all is well. */
  problem: string | null;
  /** Shown while saving keeps failing. */
  saveProblem: string | null;
  busy: boolean;
  microphoneLabel: string | null;
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
}

const SAVE_EVERY_MS = 2_500;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 8_000];
const MS_PER_CHUNK_SAMPLE = 1000 / 16_000;

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `seg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

function describeSpeechError(reason: string): string {
  if (reason === 'not_authorised') return 'The speech-to-text service refused the connection. Please tell the practice manager.';
  if (reason === 'quota_exceeded') return 'The speech-to-text account has reached its limit. Please tell the practice manager.';
  return 'The connection to speech-to-text dropped.';
}

export function useScribe(o: UseScribeOptions) {
  const [state, setState] = useState<ScribeState>({
    phase: o.session.status === 'RECORDING' ? 'interrupted' : 'idle',
    lines: [],
    partial: '',
    level: 0,
    unsaved: 0,
    problem: o.session.status === 'RECORDING' ? 'Recording was interrupted on this screen (the page was reloaded). Nothing is being captured.' : null,
    saveProblem: null,
    busy: false,
    microphoneLabel: null,
  });
  const patch = useCallback((p: Partial<ScribeState> | ((s: ScribeState) => Partial<ScribeState>)) => {
    setState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
  }, []);

  const optsRef = useRef(o);
  optsRef.current = o;
  const sessionRef = useRef(o.session);
  sessionRef.current = o.session;

  const capture = useRef<CaptureHandle | null>(null);
  const transcriber = useRef<Transcriber | null>(null);
  /** Total audio captured on this screen since recording began, in ms. Speech-to-text times are offsets from when each connection opened. */
  const capturedMs = useRef(0);
  const connectionBaseMs = useRef(0);
  const seq = useRef(0);
  const outbox = useRef<TranscriptSegmentInput[]>([]);
  const saving = useRef(false);
  const saveFailures = useRef(0);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gapStartMs = useRef<number | null>(null);
  const alive = useRef(true);
  /** Bumped whenever capture stops, so an attempt still opening knows it has been overtaken. */
  const generation = useRef(0);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);

  // ---- saving -------------------------------------------------------------

  const flush = useCallback(async (): Promise<boolean> => {
    if (saving.current) return false;
    const batch = outbox.current.slice(0, MAX_SEGMENTS_PER_SAVE);
    if (batch.length === 0) return true;
    saving.current = true;
    try {
      const s = sessionRef.current;
      await optsRef.current.backend.saveTranscript(s.sessionId, optsRef.current.surgeryId, batch);
      const savedIds = new Set(batch.map((b) => b.segmentId));
      outbox.current = outbox.current.filter((b) => !savedIds.has(b.segmentId));
      saveFailures.current = 0;
      if (alive.current) {
        patch((st) => ({
          lines: st.lines.map((l) => (savedIds.has(l.key) ? { ...l, saved: true } : l)),
          unsaved: outbox.current.length,
          saveProblem: null,
        }));
      }
      return outbox.current.length === 0;
    } catch (err) {
      saveFailures.current += 1;
      const refused = err instanceof BackendError && (err.code === 'SESSION_TRANSITION_REFUSED' || err.code === 'FORBIDDEN' || err.code === 'VALIDATION');
      if (alive.current) {
        patch({
          unsaved: outbox.current.length,
          saveProblem: refused
            ? `The transcript could not be saved: ${err instanceof Error ? err.message : 'refused'}`
            : `${outbox.current.length} transcript line${outbox.current.length === 1 ? '' : 's'} not saved yet. Retrying. Keep this page open.`,
        });
      }
      return false;
    } finally {
      saving.current = false;
    }
  }, [patch]);

  useEffect(() => {
    const t = setInterval(() => {
      if (outbox.current.length > 0) void flush();
    }, SAVE_EVERY_MS);
    return () => clearInterval(t);
  }, [flush]);

  // ---- transcript events --------------------------------------------------

  const addPieces = useCallback(
    (pieces: SpeechPiece[]) => {
      const base = connectionBaseMs.current;
      const segs: TranscriptSegmentInput[] = pieces.map((p) => ({
        segmentId: newId(),
        seq: (seq.current += 1),
        startMs: Math.max(0, Math.round(base + p.startS * 1000)),
        endMs: Math.max(0, Math.round(base + Math.max(p.endS, p.startS) * 1000)),
        speaker: p.speaker,
        text: p.text,
      }));
      outbox.current.push(...segs);
      patch((st) => ({
        lines: [
          ...st.lines,
          ...segs.map((x) => ({ key: x.segmentId, kind: 'speech' as const, speaker: x.speaker, text: x.text, startMs: x.startMs, saved: false })),
        ],
        unsaved: outbox.current.length,
      }));
    },
    [patch],
  );

  const markGap = useCallback(
    (fromMs: number, toMs: number) => {
      patch((st) => ({
        lines: [...st.lines, { key: `gap-${fromMs}`, kind: 'gap', speaker: null, text: `Speech between these points may be missing (${Math.max(1, Math.round((toMs - fromMs) / 1000))} s).`, startMs: fromMs, saved: true }],
      }));
    },
    [patch],
  );

  // ---- devices ------------------------------------------------------------

  const releaseWakeLock = () => {
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  };

  const stopDevices = useCallback(async (mode: 'finish' | 'drop') => {
    // Anything still opening (microphone, token, connection) belongs to an older attempt and must not start.
    generation.current += 1;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    const t = transcriber.current;
    transcriber.current = null;
    if (t) {
      if (mode === 'finish') await t.finish();
      else t.close();
    }
    const c = capture.current;
    capture.current = null;
    await c?.stop();
    releaseWakeLock();
    if (alive.current) patch({ level: 0, partial: '' });
  }, [patch]);

  // Forward reference: openStream and scheduleReconnect call each other.
  const openStreamRef = useRef<() => Promise<boolean>>(async () => false);

  const scheduleReconnect = useCallback(
    (reason: string, retryable: boolean) => {
      transcriber.current = null;
      if (gapStartMs.current === null) gapStartMs.current = capturedMs.current;
      const attempt = reconnectAttempt.current;
      if (!retryable || attempt >= RECONNECT_DELAYS_MS.length) {
        void (async () => {
          await stopDevices('drop');
          if (gapStartMs.current !== null) markGap(gapStartMs.current, capturedMs.current);
          gapStartMs.current = null;
          if (alive.current) {
            patch({
              phase: 'interrupted',
              problem: `${describeSpeechError(reason)} Recording has stopped capturing. Check the internet connection, then continue recording.`,
            });
          }
        })();
        return;
      }
      reconnectAttempt.current = attempt + 1;
      patch({ phase: 'reconnecting', partial: '', problem: `${describeSpeechError(reason)} Reconnecting… speech during this gap is not being transcribed.` });
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        void openStreamRef.current();
      }, RECONNECT_DELAYS_MS[attempt]);
    },
    [markGap, patch, stopDevices],
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
            capturedMs.current += pcm.length * MS_PER_CHUNK_SAMPLE;
            transcriber.current?.sendAudio(pcm);
          },
          onLevel: (level) => alive.current && patch({ level }),
          onEnded: () => {
            void (async () => {
              await stopDevices('finish');
              await flush();
              if (alive.current) {
                patch({ phase: 'interrupted', problem: 'The microphone stopped (unplugged or taken by another program). Nothing is being captured. Check it, then continue recording.' });
              }
            })();
          },
        });
        if (overtaken()) {
          await handle.stop();
          return false;
        }
        capture.current = handle;
        patch({ microphoneLabel: handle.label });
      } catch (err) {
        if (overtaken()) return false;
        if (alive.current) patch({ phase: 'interrupted', problem: err instanceof MicrophoneError ? err.message : 'The microphone could not be started.' });
        return false;
      }
      try {
        const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
        wakeLock.current = (await nav.wakeLock?.request('screen')) ?? null;
      } catch {
        // Not supported or refused: the device policy must keep the PC awake (docs/deployment.md).
      }
    }
    let token;
    try {
      token = await backend.getSpeechToken(s.sessionId, surgeryId);
    } catch (err) {
      if (overtaken()) return false;
      const retryable = !(err instanceof BackendError) || err.code === 'SPEECH_UNAVAILABLE' || err.code === 'NETWORK' || err.code === 'TIMEOUT';
      if (!retryable && alive.current) {
        await stopDevices('drop');
        patch({ phase: 'interrupted', problem: err instanceof Error ? err.message : 'Speech-to-text could not start.' });
        return false;
      }
      scheduleReconnect('token_failed', true);
      return false;
    }
    if (overtaken()) return false;
    connectionBaseMs.current = capturedMs.current;
    try {
      transcriber.current = connect(token, {
        onReady: () => {
          reconnectAttempt.current = 0;
          if (gapStartMs.current !== null) {
            markGap(gapStartMs.current, capturedMs.current);
            gapStartMs.current = null;
          }
          if (alive.current) patch({ phase: 'live', problem: null });
        },
        onPartial: (text) => alive.current && patch({ partial: text }),
        onFinal: addPieces,
        onError: (reason, retryable) => scheduleReconnect(reason, retryable),
      });
    } catch {
      scheduleReconnect('connection_failed', true);
      return false;
    }
    return true;
  }, [addPieces, flush, markGap, patch, scheduleReconnect, stopDevices]);
  openStreamRef.current = openStream;

  // ---- actions ------------------------------------------------------------

  const serverAction = useCallback(async (action: RecordingAction): Promise<boolean> => {
    const s = sessionRef.current;
    const { backend, surgeryId, onSessionChange, onWarning } = optsRef.current;
    try {
      const res = await backend.changeRecording(s.sessionId, surgeryId, action, s.version);
      sessionRef.current = res.session;
      onSessionChange(res.session);
      if (res.warning) onWarning?.(res.warning);
      return true;
    } catch (err) {
      if (alive.current) patch({ problem: err instanceof Error ? err.message : 'That did not work. Try again.' });
      return false;
    }
  }, [patch]);

  /** Start (from READY), resume (from PAUSED or STOPPED), or reconnect after an interruption (already RECORDING). */
  const start = useCallback(async () => {
    patch({ busy: true, problem: null, phase: 'connecting' });
    const status = sessionRef.current.status;
    let ok = true;
    if (status === 'READY') ok = await serverAction('START');
    else if (status === 'PAUSED' || status === 'STOPPED') ok = await serverAction('RESUME');
    if (ok) {
      reconnectAttempt.current = 0;
      if (status === 'RECORDING' && state.phase === 'interrupted' && capturedMs.current === 0) {
        // Reloaded page: continue after the last saved line so times keep increasing.
        capturedMs.current = Math.max(0, ...state.lines.map((l) => l.startMs + 1000));
      }
      ok = await openStream();
    }
    if (!ok && alive.current) patch((st) => ({ phase: st.phase === 'connecting' ? (sessionRef.current.status === 'RECORDING' ? 'interrupted' : 'idle') : st.phase }));
    if (alive.current) patch({ busy: false });
  }, [openStream, patch, serverAction, state.lines, state.phase]);

  const pauseOrStop = useCallback(
    async (action: 'PAUSE' | 'STOP') => {
      patch({ busy: true, phase: 'finishing', problem: null });
      await stopDevices('finish');
      if (gapStartMs.current !== null) {
        markGap(gapStartMs.current, capturedMs.current);
        gapStartMs.current = null;
      }
      const ok = await serverAction(action);
      await flush();
      if (alive.current) patch({ busy: false, phase: ok ? 'idle' : 'interrupted' });
    },
    [flush, markGap, patch, serverAction, stopDevices],
  );

  /** The patient withdrew permission: stop at once, keep nothing. The caller records the withdrawal. */
  const abandon = useCallback(async () => {
    outbox.current = [];
    await stopDevices('drop');
    if (alive.current) patch({ phase: 'idle', lines: [], partial: '', unsaved: 0, saveProblem: null, problem: null });
  }, [patch, stopDevices]);

  /** Loads what was saved before (after a page reload). */
  const restore = useCallback((lines: TranscriptLine[], maxSeq: number) => {
    seq.current = Math.max(seq.current, maxSeq);
    patch((st) => (st.lines.length ? {} : { lines }));
  }, [patch]);

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
      // Leaving the screen: still try to save what was finished.
      void flush();
    };
  }, [flush, stopDevices]);

  return { state, start, pause: () => pauseOrStop('PAUSE'), stop: () => pauseOrStop('STOP'), abandon, restore, flush };
}
