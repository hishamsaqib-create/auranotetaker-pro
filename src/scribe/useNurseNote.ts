// Nurse notes: typed during the appointment, saved automatically a moment after typing stops.
//
// SAFETY: each save names the revision it edited, so two screens cannot silently overwrite each other.
// Unsaved notes are always visible as unsaved, and the page asks before closing with unsaved notes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NurseNote } from '../../lib/core/transcript.ts';
import type { AppBackend } from '../backend/types.ts';
import { BackendError } from '../backend/types.ts';
import { setNurseNotesUnsaved } from './pendingSaves.ts';

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
  const inFlightPromise = useRef<Promise<void> | null>(null);
  /** While permission is being withdrawn nothing more is sent. */
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(o);
  optsRef.current = o;
  const alive = useRef(true);

  const load = useCallback((note: NurseNote | null) => {
    if (timer.current) clearTimeout(timer.current);
    held.current = false;
    revision.current = note?.revision ?? 0;
    savedText.current = note?.text ?? '';
    textRef.current = savedText.current;
    setTextState(savedText.current);
    setStatus('saved');
    setMessage(null);
  }, []);

  const saveOnce = useCallback(async () => {
    if (held.current || inFlight.current || textRef.current === savedText.current) return;
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
    if (textRef.current !== savedText.current) await saveOnce();
  }, []);

  const save = useCallback(() => {
    if (!inFlightPromise.current) {
      inFlightPromise.current = saveOnce().finally(() => {
        inFlightPromise.current = null;
      });
    }
    return inFlightPromise.current;
  }, [saveOnce]);

  /** Another screen saved first: take its notes and keep what was typed here underneath, unsaved. */
  const mergeLatest = useCallback((latest: NurseNote | null) => {
    const mine = textRef.current;
    const theirs = latest?.text ?? '';
    revision.current = latest?.revision ?? 0;
    savedText.current = theirs;
    const merged = mine && mine !== theirs && !theirs.includes(mine) ? `${theirs}${theirs ? '\n\n' : ''}${mine}` : theirs;
    textRef.current = merged;
    setTextState(merged);
    setMessage(null);
    setStatus(merged === theirs ? 'saved' : 'unsaved');
    if (merged !== theirs) void save();
  }, [save]);

  /** Loading failed: let typing continue; the first save will say if notes already exist. */
  const loadFailed = useCallback(() => {
    setStatus((s) => (s === 'loading' ? 'saved' : s));
  }, []);

  /** Before a withdrawal: stop saving and wait for a save already under way. */
  const hold = useCallback(async () => {
    held.current = true;
    if (timer.current) clearTimeout(timer.current);
    await inFlightPromise.current;
  }, []);

  const release = useCallback(() => {
    held.current = false;
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
    setNurseNotesUnsaved(status === 'unsaved' || status === 'saving');
  }, [status]);

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

  return { text, setText, status, message, load, mergeLatest, loadFailed, hold, release, saveNow: save };
}
