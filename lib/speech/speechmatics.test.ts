import { describe, expect, it } from 'vitest';
import { endOfStreamMessage, parseSpeechmaticsMessage, piecesFromResults, startRecognitionMessage } from './speechmatics.ts';

const word = (content: string, speaker: string, start: number, end = start + 0.4) => ({
  type: 'word',
  start_time: start,
  end_time: end,
  alternatives: [{ content, speaker }],
});
const punct = (content: string, speaker: string, at: number) => ({
  type: 'punctuation',
  start_time: at,
  end_time: at,
  attaches_to: 'previous',
  alternatives: [{ content, speaker }],
});

describe('Speechmatics messages', () => {
  it('asks for British English, partials, speaker labels and dental vocabulary, as 16 kHz PCM', () => {
    const m = startRecognitionMessage();
    expect(m.audio_format).toEqual({ type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 });
    expect(m.transcription_config).toMatchObject({ language: 'en', output_locale: 'en-GB', enable_partials: true, diarization: 'speaker' });
    expect(m.transcription_config.additional_vocab).toContain('mesial');
    expect(endOfStreamMessage(12)).toEqual({ message: 'EndOfStream', last_seq_no: 12 });
  });

  it('splits a final transcript where the speaker changes and attaches punctuation', () => {
    const pieces = piecesFromResults([
      word('Any', 'S1', 1),
      word('pain', 'S1', 1.4),
      punct('?', 'S1', 1.8),
      word('Only', 'S2', 2.5),
      word('cold', 'S2', 2.9),
      punct('.', 'S2', 3.3),
    ]);
    expect(pieces).toEqual([
      { speaker: 'S1', text: 'Any pain?', startS: 1, endS: 1.8 },
      { speaker: 'S2', text: 'Only cold.', startS: 2.5, endS: 3.3 },
    ]);
  });

  it('treats an unknown speaker as null, not as a person', () => {
    expect(piecesFromResults([word('Hello', 'UU', 0)])[0]!.speaker).toBeNull();
  });

  it('reads each message type', () => {
    expect(parseSpeechmaticsMessage('{"message":"RecognitionStarted","id":"x"}')).toEqual({ type: 'started' });
    expect(parseSpeechmaticsMessage('{"message":"AudioAdded","seq_no":3}')).toEqual({ type: 'audio-added', seqNo: 3 });
    expect(parseSpeechmaticsMessage('{"message":"AddPartialTranscript","metadata":{"transcript":" lower left "}}')).toEqual({ type: 'partial', text: 'lower left' });
    expect(parseSpeechmaticsMessage(JSON.stringify({ message: 'AddTranscript', results: [word('Six', 'S1', 0)] }))).toEqual({
      type: 'final',
      pieces: [{ speaker: 'S1', text: 'Six', startS: 0, endS: 0.4 }],
    });
    expect(parseSpeechmaticsMessage('{"message":"EndOfTranscript"}')).toEqual({ type: 'end' });
    expect(parseSpeechmaticsMessage('{"message":"Info","type":"recognition_quality"}')).toEqual({ type: 'ignored' });
  });

  it('reports errors, saying which may work on a new connection', () => {
    expect(parseSpeechmaticsMessage('{"message":"Error","type":"not_authorised"}')).toEqual({ type: 'error', reason: 'not_authorised', retryable: false });
    expect(parseSpeechmaticsMessage('{"message":"Error","type":"job_error"}')).toEqual({ type: 'error', reason: 'job_error', retryable: true });
    expect(parseSpeechmaticsMessage('not json')).toMatchObject({ type: 'error' });
  });
});
