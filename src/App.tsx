import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScribeSession } from '../lib/core/session.ts';
import { isTerminal } from '../lib/core/session.ts';
import { DEFAULT_TIME_ZONE, MINUTE_MS } from '../lib/core/time.ts';
import type { PatientSummary } from '../lib/dentally/types.ts';
import type { ScribeOutcome, SessionRestriction, SetupOptionsResponse } from '../lib/server/handlers.ts';
import type { AppBackend, CurrentUser } from './backend/types.ts';
import { DemoBanner } from './components/DemoBanner.tsx';
import { Header } from './components/Header.tsx';
import { Notice } from './components/Notice.tsx';
import { PatientConfirmation } from './components/PatientConfirmation.tsx';
import { SessionPanel } from './components/SessionPanel.tsx';
import type { DeviceSetup } from './components/Setup.tsx';
import { loadDeviceSetup, saveDeviceSetup, Setup } from './components/Setup.tsx';
import { SignIn } from './components/SignIn.tsx';
import type { Tone } from './components/StatusPill.tsx';
import { STALE_AFTER_MS, useDiary } from './hooks/useDiary.ts';
import { useNow } from './hooks/useNow.ts';

export interface AppProps {
  backend: AppBackend;
  clock?: () => number;
}

export function App({ backend, clock = Date.now }: AppProps) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);

  const loadUser = useCallback(async () => {
    try {
      setUser(await backend.getCurrentUser());
      setAuthError(null);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in failed.');
      setUser(null);
    }
  }, [backend]);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  if (user === undefined) {
    return (
      <main className="gate">
        <p className="gate-lead">Starting AuraNoteTaker…</p>
      </main>
    );
  }
  if (!user) return <SignIn backend={backend} error={authError} onSignedIn={() => void loadUser()} />;

  return (
    <Workspace
      backend={backend}
      user={user}
      clock={clock}
      onSignOut={async () => {
        await backend.signOut();
        setUser(null);
      }}
    />
  );
}

/** A computer clock further out than this gets a visible warning (the app itself uses the server's time). */
export const CLOCK_SKEW_WARNING_MS = 2 * MINUTE_MS;

function Workspace({ backend, user, clock, onSignOut }: { backend: AppBackend; user: CurrentUser; clock: () => number; onSignOut: () => void }) {
  const localNow = useNow(1000, clock);
  const [options, setOptions] = useState<SetupOptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [setup, setSetup] = useState<DeviceSetup | null>(null);
  const [editingSetup, setEditingSetup] = useState(false);
  const [session, setSession] = useState<ScribeSession | null>(null);
  const [restriction, setRestriction] = useState<SessionRestriction | null>(null);
  const [sessionPatient, setSessionPatient] = useState<PatientSummary | null>(null);
  const [localOutcomes, setLocalOutcomes] = useState<Readonly<Record<string, ScribeOutcome>>>({});
  const [sessionCheckError, setSessionCheckError] = useState<string | null>(null);

  useEffect(() => {
    backend
      .getSetupOptions()
      .then((o) => {
        setOptions(o);
        setSetup(loadDeviceSetup(o));
      })
      .catch((err: unknown) => setOptionsError(err instanceof Error ? err.message : 'Could not load the clinic setup.'));
  }, [backend]);

  const clinician = options?.clinicians.find((c) => c.practitionerId === setup?.practitionerId) ?? null;
  const surgery = options?.surgeries.find((s) => s.surgeryId === setup?.surgeryId) ?? null;
  const timeZone = options?.timeZone ?? DEFAULT_TIME_ZONE;
  const roomNames = useMemo(
    () => Object.fromEntries((options?.surgeries ?? []).filter((s) => s.roomId).map((s) => [s.roomId as string, s.name])),
    [options],
  );

  const diary = useDiary(backend, clinician && surgery && !editingSetup ? clinician.practitionerId : null, clock);
  // SAFETY (hazard H01): predictions and the clock on screen use the server's time, so a computer whose
  // clock is wrong does not suggest the wrong appointment. A clock that is far out is also pointed out.
  const offset = diary.clockOffsetMs ?? 0;
  const now = localNow + offset;
  // Declines on this screen count at once; the server's record (which survives a page refresh) wins.
  const outcomes = useMemo(() => ({ ...localOutcomes, ...diary.scribeOutcomes }), [localOutcomes, diary.scribeOutcomes]);

  // Restore an open session for this surgery or clinician after a page refresh, with its locked patient.
  const reloadSession = useCallback(async () => {
    if (!clinician || !surgery) return;
    try {
      const found = await backend.getActiveSession(surgery.surgeryId, clinician.practitionerId);
      const open = found.session && !isTerminal(found.session.status) ? found.session : null;
      setSession(open);
      setRestriction(open ? found.restriction : null);
      setSessionPatient(null);
      setSessionCheckError(null);
    } catch (err) {
      // Never silent: an open session may exist that this screen cannot see, or a change was saved
      // without its audit record. Leave the current view as it is and say so.
      setSessionCheckError(err instanceof Error ? err.message : 'Could not check for an open session.');
    }
  }, [backend, clinician, surgery?.surgeryId]);

  useEffect(() => {
    void reloadSession();
  }, [reloadSession]);

  const dentallyStatus: { tone: Tone; label: string } = (() => {
    if (!clinician) return { tone: 'neutral', label: 'Dentally' };
    if (diary.error && diary.appointments.length === 0) {
      return diary.error.code === 'DENTALLY_AUTH' ? { tone: 'bad', label: 'Dentally sign-in problem' } : { tone: 'bad', label: 'Dentally offline' };
    }
    if (diary.lastOkAt === null) return { tone: 'neutral', label: 'Checking Dentally' };
    const age = localNow - diary.lastOkAt;
    if (diary.error || age > STALE_AFTER_MS) return { tone: 'warn', label: `Dentally: updated ${Math.max(1, Math.round(age / 60000))} min ago` };
    return { tone: backend.mode === 'demo' ? 'demo' : 'ok', label: backend.mode === 'demo' ? 'Demo diary' : 'Dentally connected' };
  })();

  const header = (
    <Header
      user={user}
      clinicianName={clinician?.displayName ?? null}
      surgeryName={surgery?.name ?? null}
      now={now}
      timeZone={timeZone}
      dentally={dentallyStatus}
      onChangeSetup={session && !restriction ? undefined : () => setEditingSetup(true)}
      onSignOut={onSignOut}
    />
  );
  const banner = backend.demo ? <DemoBanner demo={backend.demo} timeZone={timeZone} onScenarioChange={diary.refresh} /> : null;

  if (optionsError) {
    return (
      <div className="app">
        {header}
        {banner}
        <main className="setup">
          <Notice tone="bad" title={optionsError} />
        </main>
      </div>
    );
  }
  if (!options) {
    return (
      <div className="app">
        {header}
        {banner}
        <main className="setup">
          <p className="state-lead">Loading the clinic setup…</p>
        </main>
      </div>
    );
  }
  if (!clinician || !surgery || editingSetup) {
    return (
      <div className="app">
        {header}
        {banner}
        <Setup
          options={options}
          initial={setup}
          onCancel={clinician && surgery ? () => setEditingSetup(false) : undefined}
          onSave={(s) => {
            saveDeviceSetup(s);
            setSetup(s);
            setEditingSetup(false);
          }}
        />
      </div>
    );
  }

  const skewMinutes = Math.round(Math.abs(offset) / MINUTE_MS);

  return (
    <div className="app">
      {header}
      {banner}
      <main className="main">
        {sessionCheckError && (
          <Notice
            tone="warn"
            title="Could not check for an open session in this surgery"
            action={
              <button type="button" className="button button-secondary" onClick={() => void reloadSession()}>
                Try again
              </button>
            }
          >
            {sessionCheckError}
          </Notice>
        )}
        {Math.abs(offset) > CLOCK_SKEW_WARNING_MS && (
          <Notice tone="warn" title={`This computer's clock is ${skewMinutes} minutes ${offset > 0 ? 'slow' : 'fast'}`}>
            AuraNoteTaker is using the correct time from its server. Ask whoever looks after the practice's computers to correct this clock.
          </Notice>
        )}
        {session ? (
          <SessionPanel
            // Keyed by patient as well: if a session ever comes back with a different patient, the banner starts afresh.
            key={`${session.sessionId}:${session.patient.dentallyPatientId}`}
            backend={backend}
            session={session}
            restriction={restriction}
            patient={sessionPatient}
            currentSurgeryId={surgery.surgeryId}
            timeZone={timeZone}
            clinicianName={options.clinicians.find((c) => c.practitionerId === session.clinicianId)?.displayName ?? clinician.displayName}
            surgeryName={options.surgeries.find((x) => x.surgeryId === session.surgeryId)?.name ?? null}
            onSessionChange={setSession}
            onReload={() => void reloadSession()}
            onClose={(declinedAppointmentId) => {
              if (declinedAppointmentId) setLocalOutcomes((prev) => ({ ...prev, [declinedAppointmentId]: 'DECLINED' }));
              setSession(null);
              setRestriction(null);
              setSessionPatient(null);
              diary.refresh();
            }}
          />
        ) : (
          <PatientConfirmation
            backend={backend}
            diary={diary}
            now={now}
            timeZone={timeZone}
            clinician={clinician}
            surgery={surgery}
            roomNames={roomNames}
            outcomes={outcomes}
            onConfirmed={(s, patient) => {
              setSession(s);
              setRestriction(null);
              setSessionPatient(patient);
            }}
            onOpenExistingSession={() => void reloadSession()}
          />
        )}
      </main>
    </div>
  );
}

