# Working on AuraNoteTaker Pro

This is healthcare software handling special category data. Read `docs/clinical-safety.md` and `docs/security-and-privacy.md` before changing behaviour.

## Non-negotiables

- Never print, log, commit or duplicate secrets. Backend secrets live in Base44 (`npx base44 secrets set`). `.env.example` holds names only.
- Never use real patient data in code, tests, fixtures, issues, screenshots or demo data. Use demo mode or the Dentally sandbox. Never run `npx base44 dev --remote` against production.
- Never attach clinical information to a patient without explicit human confirmation. Never change a session's patient except through `REASSIGN_PATIENT`.
- Never add a write method to the Dentally client. Never use appointment `notes` or `metadata` as a substitute for clinical notes. No scraping or screen automation of Dentally.
- Never put names, dates of birth, transcript or note text into audit details or logs (`lib/core/audit.ts` allowlists enforce this).
- Never fall back silently: unknown states, unreadable records and outages are surfaced, not guessed around.

## Escalate, do not decide

Ask Hisham before anything involving: clinical safety, patient identity, data loss, security, production credentials, destructive database changes, or Dentally production writes. Open decisions are listed in `docs/roadmap.md`.

## Code conventions

- `lib/` is dependency-free TypeScript that must run in browsers, Deno (Base44 functions) and Node. Use explicit `.ts` extensions in relative imports and `import type` for types.
- Handlers in `lib/server/handlers.ts` take `(ctx, deps, input)`. The caller's clinic and roles come from `ctx` (resolved from `StaffProfile`), never from input. Re-verify anything the client claims.
- Base44 entities deny all direct client access (except users reading their own StaffProfile). Functions are the only write path.
- British English in user-facing copy, sentence case, plain verbs.

## Adding a backend operation

1. Add the handler to `lib/server/handlers.ts` with tests in `lib/server/handlers.test.ts`.
2. Add `base44/functions/<handlerName>/entry.ts` (copy an existing entry).
3. Add the method to `src/backend/types.ts`, `demoBackend.ts` and `base44Backend.ts`.
4. Run `npm run sync:shared`.

## Before every commit

```bash
npm run typecheck && npm test && npm run check:shared && npm run build
```

Changes to `lib/core`, `lib/server`, `base44/`, prompts, templates or Agent Knowledge rules need a safety impact note in the pull request (see the template).
