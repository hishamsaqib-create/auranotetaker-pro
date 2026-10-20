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

Demo mode shows a permanent banner and lets you switch scenarios (normal day, double booking, overrun, previous appointment not marked complete, between appointments, taken in early, Dentally offline) to exercise the prediction engine. The development server defaults to demo mode; a production build must set `VITE_APP_MODE` (section 4).

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
3. Confirm the Dentally auth header by comparing with one of AuraMail's sync functions (read-only):
   ```bash
   npx base44 functions pull <aura-mail-sync-function>   # run inside a scratch copy linked to AuraMail
   ```
   Function entry points follow Base44's documented shape: a default-exported request handler, the SDK from `npm:@base44/sdk`, and secrets from `secrets.get()` in `base44:runtime`, read inside the handler.
4. Secrets: entered by Hisham in the app's **Secrets** settings in Base44, or with the CLI. Values never go in chat, the repository, issues or logs.
   | Secret | Value |
   |---|---|
   | `DENTALLY_API_TOKEN` | The app's own read-only Dentally key (D8) |
   | `DENTALLY_BASE_URL` | `https://api.sandbox.dentally.co` for a sandbox key, `https://api.dentally.co` for a live key |
   | `DENTALLY_USER_AGENT` | `AuraNoteTaker/0.1` |
   | `CLINIC_KEY` | `aura` |
   ```bash
   npx base44 secrets set DENTALLY_USER_AGENT="AuraNoteTaker/0.1" CLINIC_KEY=aura
   npx base44 secrets list
   ```
5. Frontend build settings. Create `.env.production.local` (git-ignored; these values are not secret):
   ```bash
   VITE_APP_MODE=base44
   VITE_BASE44_APP_ID=<the staging or production app ID>
   ```
   Without `VITE_APP_MODE` a production build shows a configuration error instead of starting, so a forgotten setting can never put the demo diary in front of a clinician.
6. Deploy:
   ```bash
   npm run sync:shared
   npx base44 entities push
   npx base44 functions deploy
   npx base44 deploy --build -y     # check that the CLI build picks up .env.production.local
   ```
7. Seed configuration through the admin functions (Phase 1 issue P1-05): the Clinic row (its `slug` must equal `CLINIC_KEY`), staff profiles with roles, clinician mappings from Dentally practitioners, surgeries from Dentally rooms.

## 4. Configuration reference

Frontend (Vite, build time, not secret):

| Variable | Values | Purpose |
|---|---|---|
| `VITE_APP_MODE` | `demo`, `base44` | Demo or connected mode. Required for production builds; only the development server defaults to `demo` |
| `VITE_BASE44_APP_ID` | Base44 app ID | Required in `base44` mode |
| `VITE_BASE44_SERVER_URL` | optional | Override the Base44 server URL |

Backend secrets (Base44 secret vault):

| Secret | Phase | Notes |
|---|---|---|
| `DENTALLY_API_TOKEN` | 1 | Dedicated, read-only |
| `DENTALLY_BASE_URL` | 1 | Sandbox or production |
| `DENTALLY_USER_AGENT` | 1 | Mandatory for Dentally |
| `CLINIC_KEY` | 1 | The one clinic this app serves (matches `Clinic.slug`). Callers must have an active StaffProfile in it |
| `STT_*` | 2 | Provider credentials, per D3 |
| `LLM_*` / AWS role | 3 | Bedrock access pinned to one region, per D3 |
| `GOOGLE_DRIVE_*` | 5 | Non-patient knowledge export |

## 5. Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request: install, typecheck, tests, production build, the shared-code sync check, and a secret scan. Merges to `main` require green CI and a review. Pull requests use the safety checklist in `.github/pull_request_template.md`.

## 6. Releases

1. Merge to `main`, deploy to staging, test with the Dentally sandbox.
2. For clinically consequential changes (patient identity, generation, safety checks, write-back, retention), the CSO reviews the safety impact note and updates the hazard log.
3. Deploy to production manually, at a quiet time, with the release recorded in the Clinical Safety Case log.
4. Rollback: redeploy the previous tag. Entity schema changes are additive only; destructive migrations need explicit escalation and a backup first.

Feature flags per clinic (in `Clinic.settings`): scribe enabled, `writeback_mode` (`NONE`, `EXPORT`, `API`), audit module enabled. Production write-back to Dentally stays off until D1 is resolved and the first write is signed off.

## 7. Content Security Policy

The production build injects a strict Content Security Policy as a `<meta>` tag (see `vite.config.ts`): scripts and styles from the app's own origin only, connections to the app origin and `base44.app`, no objects. Phase 2 adds the chosen speech-to-text provider's streaming endpoint to `connect-src`. Development builds omit it so Vite's hot reload works.

Framing cannot be blocked from a `<meta>` tag: browsers ignore `frame-ancestors` there. The host must send it as an HTTP header, `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`). Whether Base44 hosting can add response headers is to be confirmed in P1-01; if it cannot, the frontend should be served from a host that can. Meanwhile the connected app refuses to start inside a frame. The demo build may be framed, because it holds only fictional data.

## 8. Surgery PC checklist

- [ ] Managed device, full-disk encryption, automatic screen lock, updates current
- [ ] Chrome or Edge managed; AuraNoteTaker excluded from tab discarding (`TabDiscardingExceptions`) or sleeping tabs (`SleepingTabsBlockedForUrls`); no unmanaged extensions
- [ ] Operating system sleep disabled during clinic hours
- [ ] Wired or USB desk microphone tested; exclusive mode off
- [ ] Staff sign in with their own accounts; no shared logins
- [ ] Clinician and surgery set on first use
