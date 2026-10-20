// Live speech-to-text connections: Speechmatics over a WebSocket, or a scripted transcript in demo mode.
//
// SAFETY: a connection that fails is always reported (onError), never quietly dropped, so the screen can
// say that speech may be missing. Audio sent before Speechmatics is ready is held briefly, not discarded.

import type { SpeechPiece } from '../../lib/speech/speechmatics.ts';
import { endOfStreamMessage, parseSpeechmaticsMessage, startRecognitionMessage } from '../../lib/speech/speechmatics.ts';

export interface TranscriberEvents {
  onReady(): void;
  onPartial(text: string): void;
  onFinal(pieces: SpeechPiece[]): void;
  /** The connection failed. `retryable` says whether a new connection may work. */
  onError(reason: string, retryable: boolean): void;
}

export interface Transcriber {
  sendAudio(pcm: Int16Array): void;
  /**
   * Sends end of audio and waits (up to a few seconds) for the last finished transcript.
   * Resolves false when the end could not be confirmed, so the screen can mark that words may be missing.
   */
  finish(): Promise<boolean>;
  /** Closes at once. Anything not yet transcribed is dropped (used when permission is withdrawn). */
  close(): void;
}

export type ConnectTranscriber = (token: { provider: 'SPEECHMATICS' | 'DEMO'; url: string | null }, events: TranscriberEvents) => Transcriber;

/** About 10 seconds of audio may wait for the connection; more than that is a failure, reported as such. */
const MAX_QUEUED_CHUNKS = 100;
const MAX_BUFFERED_BYTES = 2_000_000;
const FINISH_TIMEOUT_MS = 6_000;

export function connectSpeechmatics(url: string, events: TranscriberEvents): Transcriber {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let ready = false;
  let finished = false;
  let failed = false;
  /** EndOfStream sent: Speechmatics may close the connection itself once the last transcript is out. */
  let ending = false;
  let sent = 0;
  const queue: Int16Array[] = [];
  let endResolve: (() => void) | null = null;
  let endConfirmed: (() => void) | null = null;

  const fail = (reason: string, retryable: boolean) => {
    if (failed || finished) return;
    failed = true;
    events.onError(reason, retryable);
    try {
      ws.close();
    } catch {
      // already closed
    }
  };

  const send = (pcm: Int16Array) => {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      fail('network_too_slow', true);
      return;
    }
    ws.send(new Int16Array(pcm));
    sent += 1;
  };

  ws.onopen = () => ws.send(JSON.stringify(startRecognitionMessage()));
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') return;
    const ev = parseSpeechmaticsMessage(e.data);
    switch (ev.type) {
      case 'started':
        ready = true;
        for (const chunk of queue.splice(0)) send(chunk);
        events.onReady();
        break;
      case 'partial':
        events.onPartial(ev.text);
        break;
      case 'final':
        if (ev.pieces.length) events.onFinal(ev.pieces);
        events.onPartial('');
        break;
      case 'end':
        endConfirmed?.();
        endResolve?.();
        break;
      case 'error':
        fail(ev.reason, ev.retryable);
        break;
      default:
        break;
    }
  };
  ws.onerror = () => fail('connection_failed', true);
  ws.onclose = (e: CloseEvent) => {
    endResolve?.();
    if (!finished && !failed && !ending) fail(e.code === 4001 ? 'not_authorised' : 'connection_lost', e.code !== 4001 && e.code !== 4003);
  };

  return {
    sendAudio(pcm) {
      if (finished || failed) return;
      if (!ready) {
        if (queue.length >= MAX_QUEUED_CHUNKS) fail('not_ready', true);
        else queue.push(pcm);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) send(pcm);
    },
    async finish() {
      if (failed) return false;
      if (finished) return true;
      if (!ready || ws.readyState !== WebSocket.OPEN) {
        // Audio was waiting for a connection that never became ready: it was not transcribed.
        const lost = queue.length > 0;
        finished = true;
        queue.length = 0;
        ws.close();
        return !lost;
      }
      let confirmed = false;
      const done = new Promise<void>((resolve) => {
        endResolve = resolve;
      });
      endConfirmed = () => {
        confirmed = true;
      };
      ending = true;
      ws.send(JSON.stringify(endOfStreamMessage(sent)));
      await Promise.race([done, new Promise((r) => setTimeout(r, FINISH_TIMEOUT_MS))]);
      finished = true;
      ws.close();
      return confirmed;
    },
    close() {
      finished = true;
      queue.length = 0;
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Demo mode: invented dialogue, one line every few seconds, so the screen can be tried without a speech service. */
const DEMO_LINES: ReadonlyArray<[string, string]> = [
  ['S1', 'Morning. How have things been since we last saw you?'],
  ['S2', "Mostly fine, but there's a sharp twinge on the lower left when I drink something cold."],
  ['S1', 'How long has that been going on?'],
  ['S2', 'About three weeks. It goes after a few seconds.'],
  ['S1', "Okay. Let's have a look. Lower left six has a small chip on the distal edge of the filling."],
  ['S1', 'No tenderness to percussion. Gums look healthy, BPE all ones.'],
  ['S1', "I'd suggest we replace that filling with a composite. Any questions?"],
  ['S2', 'No, that sounds fine.'],
];

export function startDemoTranscriber(events: TranscriberEvents): Transcriber {
  let line = 0;
  let elapsedS = 0;
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(setTimeout(() => !stopped && events.onReady(), 300));
  const tick = setInterval(() => {
    if (stopped) return;
    const next = DEMO_LINES[line % DEMO_LINES.length]!;
    line += 1;
    events.onPartial(next[1].split(' ').slice(0, 4).join(' '));
    timers.push(
      setTimeout(() => {
        if (stopped) return;
        events.onPartial('');
        events.onFinal([{ speaker: next[0], text: next[1], startS: elapsedS, endS: elapsedS + 3 }]);
        elapsedS += 4;
      }, 1200),
    );
  }, 4000);
  const stop = () => {
    stopped = true;
    clearInterval(tick);
    timers.forEach(clearTimeout);
  };
  return {
    sendAudio() {
      // The demo ignores audio.
    },
    async finish() {
      stop();
      return true;
    },
    close: stop,
  };
}

export const connectTranscriber: ConnectTranscriber = (token, events) => {
  if (token.provider === 'DEMO') return startDemoTranscriber(events);
  if (!token.url) throw new Error('No speech-to-text address');
  return connectSpeechmatics(token.url, events);
};
