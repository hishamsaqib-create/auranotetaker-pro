import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScribeSession } from '../lib/core/session.ts';
import { isTerminal } from '../lib/core/session.ts';
import { DEFAULT_TIME_ZONE } from '../lib/core/time.ts';
import type { SetupOptionsResponse } from '../lib/server/handlers.ts';
import type { AppBackend, CurrentUser } from './backend/types.ts';
import { DemoBanner } from './components/DemoBanner.tsx';
import { Header } from './components/Header.tsx';
import { Notice } from './components/Notice.tsx';
import type { ConfirmedPatientDisplay } from './components/PatientConfirmation.tsx';
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

function Workspace({ backend, user, clock, onSignOut }: { backend: AppBackend; user: CurrentUser; clock: () => number; onSignOut: () => void }) {
  const now = useNow(1000, clock);
  const [options, setOptions] = useState<SetupOptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [setup, setSetup] = useState<DeviceSetup | null>(null);
  const [editingSetup, setEditingSetup] = useState(false);
  const [session, setSession] = useState<ScribeSession | null>(null);
  const [sessionDisplay, setSessionDisplay] = useState<ConfirmedPatientDisplay | null>(null);
  const [finishedIds, setFinishedIds] = useState<ReadonlySet<string>>(new Set());

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

  const diary = useDiary(backend, clinician && !editingSetup ? clinician.practitionerId : null, clock);

  // Restore an open session for this surgery after a page refresh, with its locked patient.
  const reloadSession = useCallback(async () => {
    if (!clinician) return;
    try {
      const { session: found } = await backend.getActiveSession(surgery?.surgeryId ?? null, clinician.practitionerId);
      setSession(found && !isTerminal(found.status) ? found : null);
      setSessionDisplay(null);
    } catch {
      // Leave the current view as it is; the diary status shows connection problems.
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
    const age = now - diary.lastOkAt;
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
      onChangeSetup={session ? undefined : () => setEditingSetup(true)}
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
  if (!clinician || editingSetup) {
    return (
      <div className="app">
        {header}
        {banner}
        <Setup
          options={options}
          initial={setup}
          onCancel={clinician ? () => setEditingSetup(false) : undefined}
          onSave={(s) => {
            saveDeviceSetup(s);
            setSetup(s);
            setEditingSetup(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      {banner}
      <main className="main">
        {session ? (
          <SessionPanel
            key={session.sessionId}
            backend={backend}
            session={session}
            display={sessionDisplay}
            timeZone={timeZone}
            clinicianName={options.clinicians.find((c) => c.practitionerId === session.clinicianId)?.displayName ?? clinician.displayName}
            surgeryName={options.surgeries.find((x) => x.surgeryId === session.surgeryId)?.name ?? null}
            onSessionChange={setSession}
            onReload={() => void reloadSession()}
            onClose={(finishedAppointmentId) => {
              if (finishedAppointmentId) setFinishedIds((prev) => new Set(prev).add(finishedAppointmentId));
              setSession(null);
              setSessionDisplay(null);
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
            finishedIds={finishedIds}
            onConfirmed={(s, display) => {
              setSession(s);
              setSessionDisplay(display);
            }}
            onOpenExistingSession={() => void reloadSession()}
          />
        )}
      </main>
    </div>
  );
}

