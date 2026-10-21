import { formatClock } from '../../lib/core/time.ts';
import type { CurrentUser } from '../backend/types.ts';
import { HaloMark, MicIcon } from './icons.tsx';
import type { Tone } from './StatusPill.tsx';
import { StatusPill } from './StatusPill.tsx';

export interface HeaderProps {
  user: CurrentUser;
  clinicianName: string | null;
  surgeryName: string | null;
  now: number;
  timeZone: string;
  dentally: { tone: Tone; label: string };
  /** Hidden while a session is open: the clinician and surgery cannot change under a locked patient. */
  onChangeSetup?: () => void;
  /** Shown to practice managers. */
  onOpenAdmin?: () => void;
  /** Writing a note from a template, outside a session. */
  onOpenNotes?: () => void;
  /** Appointments whose note has not been done yet. */
  onOpenToDo?: () => void;
  onSignOut: () => void;
}

export function Header({ user, clinicianName, surgeryName, now, timeZone, dentally, onChangeSetup, onOpenAdmin, onOpenNotes, onOpenToDo, onSignOut }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <HaloMark />
        <span>AuraNoteTaker Pro</span>
      </div>

      <div className="topbar-context">
        {clinicianName ? (
          <>
            <span className="context-primary">{clinicianName}</span>
            <span className="context-secondary">{surgeryName ?? 'No surgery selected'}</span>
            {onChangeSetup && (
              <button type="button" className="link-button" onClick={onChangeSetup}>
                Change
              </button>
            )}
          </>
        ) : (
          <span className="context-secondary">Set up this computer</span>
        )}
      </div>

      <time className="clock" dateTime={new Date(now).toISOString()} aria-label={`Time now ${formatClock(now, timeZone)}`}>
        {formatClock(now, timeZone)}
      </time>

      <div className="topbar-status" aria-label="Connection status">
        <StatusPill tone={dentally.tone}>{dentally.label}</StatusPill>
        <StatusPill tone="neutral">
          <MicIcon /> Microphone off
        </StatusPill>
      </div>

      <div className="topbar-user">
        <span className="user-name">{user.displayName}</span>
        {onOpenNotes && (
          <button type="button" className="link-button" onClick={onOpenNotes}>
            Write a note
          </button>
        )}
        {onOpenToDo && (
          <button type="button" className="link-button" onClick={onOpenToDo}>
            Notes to do
          </button>
        )}
        {onOpenAdmin && (
          <button type="button" className="link-button" onClick={onOpenAdmin}>
            Clinic setup
          </button>
        )}
        <button type="button" className="link-button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
