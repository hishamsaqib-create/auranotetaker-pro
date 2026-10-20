// Tracks whether a note is being written and has not been copied, so screens that would close the note
// writer can ask first. Only a flag: the note text itself is never kept here or in browser storage.

let uncopied = false;

export function setNoteUncopied(value: boolean): void {
  uncopied = value;
}

export function hasUncopiedNote(): boolean {
  return uncopied;
}

/** True when it is fine to close the note writer: nothing uncopied, or the user agrees to lose it. */
export function confirmLeaveNote(): boolean {
  if (!uncopied) return true;
  const ok = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm('The note has not been copied to Dentally. Leave it?') : false;
  if (ok) uncopied = false;
  return ok;
}
