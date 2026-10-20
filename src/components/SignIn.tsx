import type { AppBackend } from '../backend/types.ts';
import { HaloMark } from './icons.tsx';

export function SignIn({ backend, onSignedIn, error }: { backend: AppBackend; onSignedIn: () => void; error: string | null }) {
  return (
    <main className="gate">
      <div className="gate-panel">
        <div className="brand brand-large">
          <HaloMark size={26} />
          <span>AuraNoteTaker Pro</span>
        </div>
        {error && (
          <p className="notice notice-bad" role="alert">
            {error}
          </p>
        )}
        {backend.demo ? (
          <>
            <h1>Sign in to the demo</h1>
            <p className="gate-lead">Choose who you are. Everything you see is fictional.</p>
            <ul className="choice-list">
              {backend.demo.users.map((u) => (
                <li key={u.email}>
                  <button
                    type="button"
                    className="choice"
                    onClick={() => {
                      backend.demo!.signInAs(u.email);
                      onSignedIn();
                    }}
                  >
                    <span className="choice-title">{u.displayName}</span>
                    <span className="choice-sub">{u.roleLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <p className="gate-lead">Use your own Aura account. Shared logins are not allowed.</p>
            <button type="button" className="button button-primary" onClick={() => void backend.signIn()}>
              Sign in with your Aura account
            </button>
          </>
        )}
      </div>
    </main>
  );
}
