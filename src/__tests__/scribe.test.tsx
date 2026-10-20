// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScribeSession } from '../../lib/core/session.ts';
import { createDemoBackend } from '../backend/demoBackend.ts';
import type { AppBackend } from '../backend/types.ts';
import { ScribeWorkspace } from '../components/ScribeWorkspace.tsx';
import type { CaptureCallbacks, StartCapture } from '../scribe/microphone.ts';
import { MicrophoneError } from '../scribe/microphone.ts';
import type { ConnectTranscriber, TranscriberEvents } from '../scribe/transcriber.ts';

const NOW = Date.parse('2026-10-20T10:40:00+01:00');
const SURGERY = 'DEMO-SURGERY-1';

afterEach(cleanup);

const startButton = async () => {
  const b = screen.getByRole('button', { name: 'Start recording' });
  await waitFor(() => expect(b).toBeEnabled());
  return b;
};
const recStatus = () => within(screen.getByRole('region', { name: 'Recording' })).getByRole('status');

async function readySession(backend: AppBackend): Promise<ScribeSession> {
  backend.demo!.signInAs('sarah.lin@demo.invalid');
  const { session } = await backend.confirmPatient({
    appointmentId: 'DEMO-A04',
    patientId: 'DEMO-P1001',
    practitionerId: 'DEMO-PR1',
    surgeryId: SURGERY,
    predictedAppointmentId: 'DEMO-A04',
    method: 'CONFIRMED_SUGGESTION',
  });
  return (await backend.recordConsent(session.sessionId, true, session.version, SURGERY)).session;
}

/** A fake microphone and speech service the test drives by hand. */
function fakes() {
  const mic: { cb: CaptureCallbacks | null; stopped: number } = { cb: null, stopped: 0 };
  const stt: { events: TranscriberEvents[]; audioChunks: number; finished: number; closed: number } = { events: [], audioChunks: 0, finished: 0, closed: 0 };
  const startCapture: StartCapture = async (_id, cb) => {
    mic.cb = cb;
    return { label: 'Desk microphone', stop: async () => void (mic.stopped += 1) };
  };
  const connect: ConnectTranscriber = (_token, events) => {
    stt.events.push(events);
    return {
      sendAudio: () => void (stt.audioChunks += 1),
      finish: async () => {
        stt.finished += 1;
        return true;
      },
      close: () => void (stt.closed += 1),
    };
  };
  return { mic, stt, startCapture, connect, listMicrophones: async () => [{ deviceId: 'mic-1', label: 'Desk microphone' }] };
}


async function renderWorkspace(backend: AppBackend, initial: ScribeSession, f: ReturnType<typeof fakes>) {
  const { useState } = await import('react');
  const seen: ScribeSession[] = [];
  const onWithdraw = vi.fn();
  function Wrapper() {
    const [session, setSession] = useState(initial);
    return (
      <ScribeWorkspace
        backend={backend}
        session={session}
        surgeryId={SURGERY}
        timeZone="Europe/London"
        firstName="Oliver"
        onSessionChange={(s) => {
          seen.push(s);
          setSession(s);
        }}
        onWithdraw={async () => {
          onWithdraw();
          const r = await backend.recordConsent(session.sessionId, false, session.version, SURGERY);
          seen.push(r.session);
          return true;
        }}
        onCancel={() => undefined}
        startCapture={f.startCapture}
        connect={f.connect}
        listMicrophones={f.listMicrophones}
      />
    );
  }
  render(<Wrapper />);
  return { seen, onWithdraw };
}

describe('scribe workspace', () => {
  it('records only after Start, shows the live transcript, and saves finished lines', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const f = fakes();
    const user = userEvent.setup();
    await renderWorkspace(backend, ready, f);

    expect(recStatus()).toHaveTextContent('Not recording');
    expect(f.mic.cb).toBeNull();
    await user.click(await startButton());
    await waitFor(() => expect(f.stt.events).toHaveLength(1));
    act(() => f.stt.events[0]!.onReady());
    expect(recStatus()).toHaveTextContent('Recording');

    act(() => f.mic.cb!.onAudio(new Int16Array(1600)));
    expect(f.stt.audioChunks).toBe(1);
    act(() => f.stt.events[0]!.onPartial('lower left'));
    expect(screen.getByText('lower left')).toBeInTheDocument();
    act(() => f.stt.events[0]!.onFinal([{ speaker: 'S1', text: 'Lower left six has a chip.', startS: 0, endS: 2 }]));
    expect(screen.getByText('Lower left six has a chip.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(recStatus()).toHaveTextContent('Stopped'));
    expect(f.stt.finished).toBe(1);
    expect(f.mic.stopped).toBe(1);
    const saved = await backend.getScribeContent(ready.sessionId, SURGERY);
    expect(saved.segments.map((s) => s.text)).toEqual(['Lower left six has a chip.']);
  });

  it('marks speech that may be missing when the connection drops, and reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
      const ready = await readySession(backend);
      const f = fakes();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderWorkspace(backend, ready, f);
      await user.click(await startButton());
      await waitFor(() => expect(f.stt.events).toHaveLength(1));
      act(() => f.stt.events[0]!.onReady());
      act(() => f.stt.events[0]!.onError('connection_lost', true));
      expect(recStatus()).toHaveTextContent('Reconnecting');
      expect(screen.getByText(/speech during this gap is not being transcribed/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      await waitFor(() => expect(f.stt.events).toHaveLength(2));
      act(() => f.stt.events[1]!.onReady());
      expect(recStatus()).toHaveTextContent('Recording');
      expect(screen.getByRole('note')).toHaveTextContent(/may be missing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says plainly when the microphone cannot be used, and records nothing', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const f = fakes();
    f.startCapture = async () => {
      throw new MicrophoneError('DENIED', 'The browser is not allowed to use the microphone. Allow it in the address bar, then try again.');
    };
    const user = userEvent.setup();
    await renderWorkspace(backend, ready, f);
    await user.click(await startButton());
    expect(await screen.findByText(/not allowed to use the microphone/)).toBeInTheDocument();
    expect(recStatus()).toHaveTextContent('Not capturing');
    expect(f.stt.events).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeInTheDocument();
  });

  it('withdrawal stops at once and deletes the transcript and nurse notes', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const f = fakes();
    const user = userEvent.setup();
    const { seen } = await renderWorkspace(backend, ready, f);
    await user.click(await startButton());
    await waitFor(() => expect(f.stt.events).toHaveLength(1));
    act(() => f.stt.events[0]!.onReady());
    act(() => f.stt.events[0]!.onFinal([{ speaker: 'S2', text: 'It hurts with cold drinks.', startS: 0, endS: 2 }]));
    await user.click(screen.getByRole('button', { name: 'Oliver has withdrawn permission' }));
    await user.click(screen.getByRole('button', { name: 'Stop and delete everything' }));
    await waitFor(() => expect(seen.at(-1)?.status).toBe('CONSENT_DECLINED'));
    expect(f.stt.closed).toBe(1);
    expect(screen.queryByText('It hurts with cold drinks.')).not.toBeInTheDocument();
    const left = await backend.getScribeContent(ready.sessionId, SURGERY);
    expect(left).toEqual({ segments: [], nurseNote: null });
  });

  it('saves nurse notes shortly after typing stops', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const f = fakes();
    const user = userEvent.setup();
    await renderWorkspace(backend, ready, f);
    const box = await screen.findByRole('textbox', { name: 'Nurse notes' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'Shade A2');
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument(), { timeout: 3000 });
    expect((await backend.getScribeContent(ready.sessionId, SURGERY)).nurseNote?.text).toBe('Shade A2');
  });

  it('saves gap markers with the transcript, so missing speech is visible later too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
      const ready = await readySession(backend);
      const f = fakes();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderWorkspace(backend, ready, f);
      await user.click(await startButton());
      await waitFor(() => expect(f.stt.events).toHaveLength(1));
      act(() => f.stt.events[0]!.onReady());
      act(() => f.stt.events[0]!.onError('connection_lost', true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      await waitFor(() => expect(f.stt.events).toHaveLength(2));
      act(() => f.stt.events[1]!.onReady());
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(recStatus()).toHaveTextContent('Stopped'));
      const saved = await backend.getScribeContent(ready.sessionId, SURGERY);
      expect(saved.segments.map((x) => x.kind)).toEqual(['GAP']);
      expect(saved.segments[0]!.text).toMatch(/Speech may be missing here: the speech-to-text connection dropped/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen the microphone when a reconnect was pending at pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
      const ready = await readySession(backend);
      const f = fakes();
      let opened = 0;
      const start = f.startCapture;
      f.startCapture = async (id, cb) => {
        opened += 1;
        return start(id, cb);
      };
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderWorkspace(backend, ready, f);
      await user.click(await startButton());
      await waitFor(() => expect(f.stt.events).toHaveLength(1));
      act(() => f.stt.events[0]!.onReady());
      act(() => f.stt.events[0]!.onError('connection_lost', true));
      await user.click(screen.getByRole('button', { name: 'Pause' }));
      await waitFor(() => expect(recStatus()).toHaveTextContent('Paused'));
      // A late error from the old connection must not schedule anything either.
      act(() => f.stt.events[0]!.onError('connection_lost', true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(f.stt.events).toHaveLength(1);
      expect(opened).toBe(1);
      expect(recStatus()).toHaveTextContent('Paused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags a microphone that goes quiet while recording, and marks the gap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
      const ready = await readySession(backend);
      const f = fakes();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderWorkspace(backend, ready, f);
      await user.click(await startButton());
      await waitFor(() => expect(f.stt.events).toHaveLength(1));
      act(() => f.stt.events[0]!.onReady());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(recStatus()).toHaveTextContent('No sound from microphone');
      act(() => f.mic.cb!.onAudio(new Int16Array(1600)));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(recStatus()).toHaveTextContent('Recording');
      expect(screen.getByRole('note')).toHaveTextContent(/no sound reached AuraNoteTaker/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps everything if the withdrawal could not be recorded', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const f = fakes();
    const user = userEvent.setup();
    const { useState } = await import('react');
    function Wrapper() {
      const [session, setSession] = useState(ready);
      return (
        <ScribeWorkspace
          backend={backend}
          session={session}
          surgeryId={SURGERY}
          timeZone="Europe/London"
          firstName="Oliver"
          onSessionChange={setSession}
          onWithdraw={async () => false}
          onCancel={() => undefined}
          startCapture={f.startCapture}
          connect={f.connect}
          listMicrophones={f.listMicrophones}
        />
      );
    }
    render(<Wrapper />);
    await user.click(await startButton());
    await waitFor(() => expect(f.stt.events).toHaveLength(1));
    act(() => f.stt.events[0]!.onReady());
    act(() => f.stt.events[0]!.onFinal([{ speaker: 'S1', text: 'Keep this line.', startS: 0, endS: 1 }]));
    await user.click(screen.getByRole('button', { name: 'Oliver has withdrawn permission' }));
    await user.click(screen.getByRole('button', { name: 'Stop and delete everything' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue recording' })).toBeInTheDocument());
    expect(screen.getByText('Keep this line.')).toBeInTheDocument();
    await waitFor(async () => expect((await backend.getScribeContent(ready.sessionId, SURGERY)).segments).toHaveLength(1), { timeout: 4000 });
  });

  it('waits for the saved transcript before offering to record, and offers a retry if it fails', async () => {
    const backend = createDemoBackend({ clock: () => NOW, latencyMs: 0 });
    const ready = await readySession(backend);
    const real = backend.getScribeContent.bind(backend);
    let fail = true;
    (backend as { getScribeContent: AppBackend['getScribeContent'] }).getScribeContent = async (...args) => {
      if (fail) throw new Error('The transcript so far could not be loaded.');
      return real(...args);
    };
    const f = fakes();
    const user = userEvent.setup();
    await renderWorkspace(backend, ready, f);
    expect(await screen.findByText('The transcript so far could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled());
  });
});
