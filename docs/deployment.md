# AuraNoteTaker Pro: Deployment

Status: draft v0.1, 20 October 2026. The Base44 code-first backend and CLI are in beta; re-check commands against `npx base44 --help` when setting up.

## 1. Environments

| Environment | Frontend | Backend | Dentally | Data |
|---|---|---|---|---|
| Local demo | `npm run dev` (demo mode, default) | In-memory, runs the real handlers | Mock service | Fictional only |
| Local integrated | `npm run dev` with `VITE_APP_MODE=base44` | `npx base44 dev` (local, throwaway backend) | Sandbox | Sandbox only |
| Staging | Base44 site, staging app | Base44 staging app | Sandbox | Sandbox only |
| Production | Base44 site, production app (UK residency, D2) | Base44 production app | Production, dedicated read-only credential (D8) | Real, after DPIA and CSO sign-off |

Rules: production credentials exist only in the production app. `npx base44 dev --remote` (which uses the deployed backend's data) is never used against production. Staging and production are separate Base44 apps, not branches of one app.

## 2. Local development

Requirements: Node.js 20.19 or later (22 recommended).

```bash
npm ci
npm run dev          # demo mode at http://localhost:5173
npm test             # all unit and UI tests
npm run typecheck
npm run build
npm run sync:shared  # copy lib/ into base44/shared/lib/ (CI checks it)
```

Demo mode shows a permanent amber banner and lets you switch scenarios (normal day, double booking, overrun, between appointments, taken in early, Dentally offline) to exercise the prediction engine.

## 3. First-time backend setup (once D2 and D8 are settled)

1. Hisham creates two Base44 apps in the Aura workspace: `auranotetaker-staging` and `auranotetaker-prod` (Enterprise, UK data residency for production per D2).
2. Developer, in the repository:
   ```bash
   npx base44 login
   npx base44 whoami
   npx base44 scaffold            # link this repo to the existing staging app (writes base44/.app.jsonc, not committed)
   npx base44 auth social-login microsoft enable   # or google, per Aura's identity provider
   npx base44 auth password-login disable
   ```
3. Verify the function runtime and Dentally auth header by pulling one of AuraMail's sync functions (read-only):
   ```bash
   npx base44 functions pull <aura-mail-sync-function>   # run inside a scratch copy linked to AuraMail
   ```
   Adjust `base44/shared/adapters/base44.ts` if the runtime or SDK import differs from the current assumption (Deno, `npm:@base44/sdk`).
4. Secrets (names only; values entered by Hisham or the developer, never committed):
   ```bash
   npx base44 secrets set DENTALLY_BASE_URL=https://api.sandbox.dentally.co
   npx base44 secrets set DENTALLY_USER_AGENT="AuraNoteTaker/0.1"
   npx base44 secrets set DENTALLY_API_TOKEN=...      # sandbox in staging, production only in prod
   npx base44 secrets set CLINIC_KEY=aura
   ```
5. Deploy:
   ```bash
   npm run sync:shared
   npx base44 entities push
   npx base44 functions deploy
   npx base44 deploy --build -y     # builds through the CLI so the app ID is injected
   ```
6. Seed configuration through the admin functions (Phase 1 issue P1-05): the Clinic row, staff profiles with roles, clinician mappings from Dentally practitioners, surgeries from Dentally rooms.

## 4. Configuration reference

Frontend (Vite, build time, not secret):

| Variable | Values | Purpose |
|---|---|---|
| `VITE_APP_MODE` | `demo` (default), `base44` | Demo or connected mode |
| `VITE_BASE44_APP_ID` | Base44 app ID | Required in `base44` mode |
| `VITE_BASE44_SERVER_URL` | optional | Override the Base44 server URL |

Backend secrets (Base44 secret vault):

| Secret | Phase | Notes |
|---|---|---|
| `DENTALLY_API_TOKEN` | 1 | Dedicated, read-only |
| `DENTALLY_BASE_URL` | 1 | Sandbox or production |
| `DENTALLY_USER_AGENT` | 1 | Mandatory for Dentally |
| `CLINIC_KEY` | 1 | Tenant key for single-tenant deployments |
| `STT_*` | 2 | Provider credentials, per D3 |
| `LLM_*` / AWS role | 3 | Bedrock access pinned to one region, per D3 |
| `GOOGLE_DRIVE_*` | 5 | Non-patient knowledge export |

## 5. Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: install, typecheck, tests, production build, the shared-code sync check, and a secret scan. Merges to `main` require green CI and a review. Pull requests use the safety checklist in `.github/pull_request_template.md`.

## 6. Releases

1. Merge to `main`, deploy to staging, test with the Dentally sandbox.
2. For clinically consequential changes (patient identity, generation, safety checks, write-back, retention), the CSO reviews the safety impact note and updates the hazard log.
3. Deploy to production manually, at a quiet time, with the release recorded in the Clinical Safety Case log.
4. Rollback: redeploy the previous tag. Entity schema changes are additive only; destructive migrations need explicit escalation and a backup first.

Feature flags per clinic (in `Clinic.settings`): scribe enabled, `writeback_mode` (`NONE`, `EXPORT`, `API`), audit module enabled. Production write-back to Dentally stays off until D1 is resolved and the first write is signed off.

## 7. Content Security Policy

The production build injects a strict Content Security Policy (see `vite.config.ts`): scripts and styles from the app's own origin only, connections to the app origin and `base44.app`, no objects, no framing. Phase 2 adds the chosen speech-to-text provider's streaming endpoint to `connect-src`. Development builds omit it so Vite's hot reload works.

## 8. Surgery PC checklist

- [ ] Managed device, full-disk encryption, automatic screen lock, updates current
- [ ] Chrome or Edge managed; AuraNoteTaker excluded from tab discarding (`TabDiscardingExceptions`) or sleeping tabs (`SleepingTabsBlockedForUrls`); no unmanaged extensions
- [ ] Operating system sleep disabled during clinic hours
- [ ] Wired or USB desk microphone tested; exclusive mode off
- [ ] Staff sign in with their own accounts; no shared logins
- [ ] Clinician and surgery set on first use
