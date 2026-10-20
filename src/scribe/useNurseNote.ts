// Nurse notes: typed during the appointment, saved automatically a moment after typing stops.
//
// SAFETY: each save names the revision it edited, so two screens cannot silently overwrite each other.
// Unsaved notes are always visible as unsaved, and the page asks before closing with unsaved notes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NurseNote } from '../../lib/core/transcript.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';

export type NurseNoteStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

const SAVE_AFTER_MS = 1_000;

export function useNurseNote(o: { backend: AppBackend; sessionId: string; surgeryId: string }) {
  const [text, setTextState] = useState('');
  const [status, setStatus] = useState<NurseNoteStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const textRef = useRef('');
  const revision = useRef(0);
  const savedText = useRef('');
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(o);
  optsRef.current = o;
  const alive = useRef(true);

  const load = useCallback((note: NurseNote | null) => {
    if (timer.current) clearTimeout(timer.current);
    revision.current = note?.revision ?? 0;
    savedText.current = note?.text ?? '';
    textRef.current = savedText.current;
    setTextState(savedText.current);
    setStatus('saved');
    setMessage(null);
  }, []);

  const save = useCallback(async () => {
    if (inFlight.current || textRef.current === savedText.current) return;
    inFlight.current = true;
    const sending = textRef.current;
    if (alive.current) setStatus('saving');
    try {
      const { nurseNote } = await optsRef.current.backend.saveNurseNote(optsRef.current.sessionId, optsRef.current.surgeryId, sending, revision.current);
      revision.current = nurseNote.revision;
      savedText.current = sending;
      if (alive.current) {
        setMessage(null);
        setStatus(textRef.current === sending ? 'saved' : 'unsaved');
      }
    } catch (err) {
      const conflict = err instanceof BackendError && err.code === 'VERSION_CONFLICT';
      if (alive.current) {
        setStatus(conflict ? 'conflict' : 'error');
        setMessage(err instanceof Error ? err.message : 'The nurse notes did not save.');
      }
      inFlight.current = false;
      return;
    }
    inFlight.current = false;
    if (textRef.current !== savedText.current) void save();
  }, []);

  const setText = useCallback(
    (value: string) => {
      textRef.current = value;
      setTextState(value);
      setStatus((s) => (s === 'conflict' ? s : 'unsaved'));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    [save],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (textRef.current !== savedText.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    alive.current = true;
    return () => {
      alive.current = false;
      window.removeEventListener('beforeunload', warn);
      if (timer.current) clearTimeout(timer.current);
      void save();
    };
  }, [save]);

  return { text, setText, status, message, load, saveNow: save };
}
