// GENERATED from lib/speech/speechmatics.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Speechmatics real-time protocol: the messages the scribe screen sends and how it reads replies. Pure.
// Reference: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
//
// PRIVACY: the EU endpoint is used so audio is processed in the EU region, never routed globally.
// Audio is streamed and not stored by AuraNoteTaker.

/** EU-pinned real-time endpoint. The browser adds `?jwt=<temporary key>`. */
export const SPEECHMATICS_RT_URL = 'wss://eu.rt.speechmatics.com/v2';
/** Where the server swaps the long-lived API key for a short-lived browser key. */
export const SPEECHMATICS_TEMP_KEY_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt';
/** Shortest lifetime Speechmatics allows. The key only has to last until the connection opens. */
export const SPEECHMATICS_TEMP_KEY_TTL_SECONDS = 60;

export const SAMPLE_RATE = 16_000;

/**
 * Dental words the recogniser should prefer. Kept short: long lists slow the start of each recording.
 * Tooth notation is left as spoken ("upper right one"); the note step writes it as UR1 (decision D5).
 */
export const DENTAL_VOCABULARY: ReadonlyArray<string | { content: string; sounds_like: string[] }> = [
  'mesial', 'distal', 'occlusal', 'buccal', 'lingual', 'palatal', 'labial', 'incisal', 'cervical', 'interproximal',
  'caries', 'carious', 'periapical', 'bitewing', 'radiograph', 'OPG', 'CBCT', 'BPE', 'gingivitis', 'periodontitis',
  'pulpitis', 'endodontic', 'composite', 'amalgam', 'glass ionomer', 'veneer', 'onlay', 'inlay', 'abutment',
  'implant', 'bridge', 'denture', 'extraction', 'root canal', 'scale and polish', 'fissure sealant', 'fluoride varnish',
  'local anaesthetic', 'articaine', 'lidocaine', 'Septanest', 'Invisalign', 'aligner', 'retainer', 'bruxism', 'TMJ',
  'mobility', 'recession', 'calculus', 'plaque', 'pocketing', 'furcation', 'abscess', 'sinus', 'occlusion', 'overjet',
  'overbite', 'crossbite', 'tooth wear', 'erosion', 'abrasion', 'attrition', 'sensitivity', 'whitening', 'bonding',
  { content: 'Aura', sounds_like: ['aura', 'ora'] },
];

export interface StartRecognitionOptions {
  sampleRate?: number;
}

export function startRecognitionMessage(o: StartRecognitionOptions = {}) {
  return {
    message: 'StartRecognition',
    audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: o.sampleRate ?? SAMPLE_RATE },
    transcription_config: {
      language: 'en',
      output_locale: 'en-GB',
      model: 'enhanced',
      enable_partials: true,
      max_delay: 2,
      diarization: 'speaker',
      additional_vocab: DENTAL_VOCABULARY,
    },
  };
}

export function endOfStreamMessage(lastSeqNo: number) {
  return { message: 'EndOfStream', last_seq_no: lastSeqNo };
}

/** A finished piece of transcript from one speaker. Times are seconds from the start of this connection. */
export interface SpeechPiece {
  speaker: string | null;
  text: string;
  startS: number;
  endS: number;
}

export type SpeechEvent =
  | { type: 'started' }
  | { type: 'audio-added'; seqNo: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; pieces: SpeechPiece[] }
  | { type: 'end' }
  | { type: 'warning'; reason: string }
  /** Speechmatics ends the session after any error. `retryable` says whether a new connection may work. */
  | { type: 'error'; reason: string; retryable: boolean }
  | { type: 'ignored' };

interface Result {
  type?: string;
  start_time?: number;
  end_time?: number;
  attaches_to?: string;
  alternatives?: { content?: string; speaker?: string }[];
}

const SPEAKER = /^[A-Za-z0-9_]{1,8}$/;
const RETRYABLE_ERRORS = new Set(['job_error', 'quota_exceeded', 'unknown_error', 'idle_timeout', 'session_timeout']);

/** Joins words, attaching punctuation to the word before it. */
function joinResults(results: readonly Result[]): string {
  let text = '';
  for (const r of results) {
    const content = r.alternatives?.[0]?.content ?? '';
    if (!content) continue;
    const attachPrevious = r.type === 'punctuation' && r.attaches_to !== 'next' && r.attaches_to !== 'both';
    text += text && !attachPrevious ? ` ${content}` : content;
  }
  return text.trim();
}

/** Splits a final transcript where the speaker changes. Punctuation stays with the speaker before it. */
export function piecesFromResults(results: readonly Result[]): SpeechPiece[] {
  const groups: { speaker: string | null; results: Result[] }[] = [];
  for (const r of results) {
    const raw = r.alternatives?.[0]?.speaker;
    const speaker = typeof raw === 'string' && SPEAKER.test(raw) && raw !== 'UU' ? raw : null;
    const last = groups[groups.length - 1];
    if (last && (r.type === 'punctuation' || last.speaker === speaker)) last.results.push(r);
    else groups.push({ speaker, results: [r] });
  }
  const pieces: SpeechPiece[] = [];
  for (const g of groups) {
    const text = joinResults(g.results);
    if (!text) continue;
    const times = g.results.filter((r) => typeof r.start_time === 'number' && typeof r.end_time === 'number');
    pieces.push({
      speaker: g.speaker,
      text,
      startS: times[0]?.start_time ?? 0,
      endS: times[times.length - 1]?.end_time ?? times[0]?.start_time ?? 0,
    });
  }
  return pieces;
}

/** Reads one text frame from Speechmatics. Anything unrecognised is ignored; malformed frames are errors. */
export function parseSpeechmaticsMessage(data: string): SpeechEvent {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { type: 'error', reason: 'unreadable_message', retryable: true };
  }
  switch (m.message) {
    case 'RecognitionStarted':
      return { type: 'started' };
    case 'AudioAdded':
      return typeof m.seq_no === 'number' ? { type: 'audio-added', seqNo: m.seq_no } : { type: 'ignored' };
    case 'AddPartialTranscript': {
      const md = m.metadata as { transcript?: unknown } | undefined;
      return { type: 'partial', text: typeof md?.transcript === 'string' ? md.transcript.trim() : '' };
    }
    case 'AddTranscript':
      return { type: 'final', pieces: Array.isArray(m.results) ? piecesFromResults(m.results as Result[]) : [] };
    case 'EndOfTranscript':
      return { type: 'end' };
    case 'Warning':
      return { type: 'warning', reason: typeof m.type === 'string' ? m.type : 'unknown' };
    case 'Error': {
      const reason = typeof m.type === 'string' ? m.type : 'unknown_error';
      return { type: 'error', reason, retryable: RETRYABLE_ERRORS.has(reason) };
    }
    default:
      return { type: 'ignored' };
  }
}
