# AuraNoteTaker Pro

An ambient AI dental scribe and clinical-record audit tool for Aura Dental Clinic.

With the patient's permission it transcribes the appointment, combines the transcript with the nurse's notes, drafts a structured dental record for the clinician to review and approve, and keeps a complete audit trail. It never diagnoses, never decides on its own which patient is in the chair, and never writes to the clinical record without the treating clinician's approval.

**Status:** Phase 1 (foundations, diary and patient confirmation) in progress. The prediction engine, patient lock, audit builder, read-only Dentally client, server handlers and main clinical screen are built and tested against fictional data. Nothing is connected to a live Base44 app or to Dentally yet; see [decisions](docs/roadmap.md#decisions).

## Try it

Requires Node.js 20.19 or later.

```bash
npm ci
npm run dev
```

Open http://localhost:5173. The development server runs in demo mode: sign in as a fictional dentist or nurse, pick a clinician and surgery, and use the scenario menu in the striped demo banner to see a normal day, a double booking, an overrun, a previous appointment never marked complete, a gap between appointments, a patient taken in early, and Dentally being unavailable. The banner's audit trail shows what is recorded.

A production build must set `VITE_APP_MODE` (`base44` for the real app); without it the app shows a configuration error rather than the demo diary. See [deployment](docs/deployment.md).

## Safety rules that shape the code

1. Nothing is attached to a patient without an explicit confirmation by a signed-in person. Ambiguous diaries get a choice with no default.
2. A session's patient is locked when it is created. Changes are explicit, reasoned and audited.
3. The AI never invents clinical facts, and never assumes consent, risks, history, radiographs, examination or treatment happened because they usually would.
4. Uncertainty and contradictions are surfaced, never silently resolved. Gaps are shown as gaps.
5. Nothing is written to Dentally without the treating clinician's approval. Dentally access is read-only today.
6. No covert recording. A decline means no recording and no AI processing.
7. The system learns style and structure, never clinical facts.

Full detail: [clinical-safety.md](docs/clinical-safety.md).

## Layout

| Path | What |
|---|---|
| `lib/core` | Prediction engine, session state machine and patient lock, audit builder, time zone helpers. No dependencies. |
| `lib/dentally` | Read-only Dentally client, response validation, capability flags, fictional mock service. |
| `lib/server` | Backend handlers with injected dependencies, plus in-memory stores for demo mode and tests. |
| `base44/` | Base44 project: entity schemas (deny-by-default access rules), thin function entry points, adapters. `base44/shared/lib` is generated from `lib/`. |
| `src/` | React web app (demo and connected modes). |
| `docs/` | Architecture, data model, Dentally integration, security and privacy, clinical safety, Agent Knowledge, deployment, roadmap. |
| `scripts/` | Shared-code sync for Base44; GitHub backlog creation. |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Web app in demo mode |
| `npm test` | All unit, handler and UI tests |
| `npm run typecheck` | Type-checks the app and the Base44 adapter |
| `npm run build` | Production build with a strict Content Security Policy (set `VITE_APP_MODE` for a deployable build) |
| `npm run build:demo-page` | The demo as one self-contained HTML page, for sharing |
| `npm run sync:shared` | Copies `lib/` into `base44/shared/lib/` (run after editing `lib/`) |
| `npm run check:shared` | Fails if the Base44 copy is stale (CI) |
| `node scripts/github/create-backlog.mjs --repo <owner>/<repo>` | Creates the milestones and issues for all seven phases |

## Documents

- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Dentally integration](docs/dentally-integration.md)
- [Security and privacy](docs/security-and-privacy.md)
- [Clinical safety](docs/clinical-safety.md)
- [Agent Knowledge](docs/agent-knowledge.md)
- [Deployment](docs/deployment.md)
- [Roadmap, decisions and blockers](docs/roadmap.md)

Developers using Claude Code: read [CLAUDE.md](CLAUDE.md) first.
