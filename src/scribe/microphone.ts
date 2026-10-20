// Microphone capture: the chosen microphone, converted to 16 kHz 16-bit mono in an AudioWorklet,
// delivered in 100 ms chunks with a level for the meter.
//
// PRIVACY: audio is only held in memory long enough to stream it. It is never written to disk,
// browser storage or the backend.

import { SAMPLE_RATE } from '../../lib/speech/speechmatics.ts';

export interface Microphone {
  deviceId: string;
  label: string;
}

export interface CaptureCallbacks {
  onAudio(pcm: Int16Array): void;
  /** 0 to 1, roughly ten times a second. */
  onLevel(level: number): void;
  /** The microphone stopped on its own (unplugged, or taken by another app). */
  onEnded(): void;
}

export interface CaptureHandle {
  readonly label: string;
  stop(): Promise<void>;
}

export type StartCapture = (deviceId: string | null, cb: CaptureCallbacks) => Promise<CaptureHandle>;
export type ListMicrophones = () => Promise<Microphone[]>;

export class MicrophoneError extends Error {
  constructor(
    readonly kind: 'DENIED' | 'NOT_FOUND' | 'BUSY' | 'UNSUPPORTED' | 'FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

const CHUNK_SAMPLES = SAMPLE_RATE / 10;

// Averages input samples into 16 kHz output (a simple low-pass and resample), then sends 100 ms chunks.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${SAMPLE_RATE};
    this.phase = 0; this.acc = 0; this.accN = 0;
    this.out = new Int16Array(${CHUNK_SAMPLES}); this.n = 0; this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.accN++; this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let v = this.acc / this.accN; this.acc = 0; this.accN = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.sumSq += v * v;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          const level = Math.min(1, Math.sqrt(this.sumSq / this.n) * 4);
          this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
          this.out = new Int16Array(${CHUNK_SAMPLES}); this.n = 0; this.sumSq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export const listMicrophones: ListMicrophones = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
};

function toMicrophoneError(err: unknown): MicrophoneError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicrophoneError('DENIED', 'The browser is not allowed to use the microphone. Allow it in the address bar, then try again.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new MicrophoneError('NOT_FOUND', 'No microphone was found. Check it is plugged in, or choose another.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new MicrophoneError('BUSY', 'The microphone is being used by another program. Close it, then try again.');
  }
  return new MicrophoneError('FAILED', 'The microphone could not be started.');
}

export const startMicrophone: StartCapture = async (deviceId, cb) => {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
    throw new MicrophoneError('UNSUPPORTED', 'This browser cannot record. Use an up-to-date Chrome or Edge.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    throw toMicrophoneError(err);
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new MicrophoneError('NOT_FOUND', 'No microphone was found.');
  }
  const context = new AudioContext();
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  let stopped = false;
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    await context.close().catch(() => undefined);
    throw new MicrophoneError('UNSUPPORTED', 'This browser cannot process audio for recording. Use an up-to-date Chrome or Edge.');
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-capture');
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    if (stopped) return;
    cb.onAudio(new Int16Array(e.data.pcm));
    cb.onLevel(e.data.level);
  };
  source.connect(node);
  // Some browsers only run a worklet that is connected to the output; it outputs silence.
  node.connect(context.destination);
  if (context.state === 'suspended') await context.resume().catch(() => undefined);
  track.addEventListener('ended', () => {
    if (!stopped) cb.onEnded();
  });

  return {
    label: track.label || 'Microphone',
    async stop() {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await context.close().catch(() => undefined);
    },
  };
};
