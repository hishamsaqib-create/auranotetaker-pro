// What the scribe screen has captured but the server has not yet confirmed, so the note writer can hold back
// AI drafting until everything is saved (otherwise a draft could be made from part of the appointment).
// Counts and a sequence number only; never any text.

let unsavedLines = 0;
let lastSeq = 0;
let nurseNotesUnsaved = false;

export function setTranscriptPending(unsaved: number, highestSeq: number): void {
  unsavedLines = unsaved;
  lastSeq = Math.max(lastSeq, highestSeq);
}

export function setNurseNotesUnsaved(value: boolean): void {
  nurseNotesUnsaved = value;
}

export function resetPendingSaves(): void {
  unsavedLines = 0;
  lastSeq = 0;
  nurseNotesUnsaved = false;
}

/** Null when everything is saved; otherwise what to tell the clinician. */
export function pendingSaveProblem(): string | null {
  if (unsavedLines > 0) return `${unsavedLines} transcript line${unsavedLines === 1 ? ' is' : 's are'} still saving. Wait a moment, then try again.`;
  if (nurseNotesUnsaved) return 'The nurse notes are still saving. Wait a moment, then try again.';
  return null;
}

/** The highest transcript line number this screen has made, so the server can check it holds them all. */
export function lastTranscriptSeq(): number {
  return lastSeq;
}
