// AuraNoteTaker Pro implementation backlog.
// Source of truth for GitHub milestones and issues. Create them with:
//   node scripts/github/create-backlog.mjs --repo <owner>/<repo> [--dry-run]
// Keep docs/roadmap.md in step with this file (npm run roadmap:issues prints the tables).

export const labels = [
  { name: 'phase:1', color: '0E8A16', description: 'Foundations, diary and patient confirmation' },
  { name: 'phase:2', color: '1D76DB', description: 'Scribe capture' },
  { name: 'phase:3', color: '5319E7', description: 'Note generation and review' },
  { name: 'phase:4', color: 'B60205', description: 'Record delivery, audit trail, failure recovery' },
  { name: 'phase:5', color: 'FBCA04', description: 'Agent Knowledge and learning' },
  { name: 'phase:6', color: 'C5DEF5', description: 'Historical audit' },
  { name: 'phase:7', color: '000000', description: 'Hardening and production readiness' },
  { name: 'safety-critical', color: 'D93F0B', description: 'Patient identity, record integrity or clinical content. Needs safety review.' },
  { name: 'decision-needed', color: 'FF7619', description: 'Escalation: needs a decision from Hisham (see docs/roadmap.md)' },
  { name: 'blocked-external', color: '6A737D', description: 'Blocked on a third party or on access' },
  { name: 'governance', color: 'BFD4F2', description: 'Clinical safety, data protection, policy' },
  { name: 'security', color: 'E99695', description: 'Security and privacy controls' },
  { name: 'spike', color: 'D4C5F9', description: 'Time-boxed investigation with recorded results' },
  { name: 'testing', color: 'C2E0C6', description: 'Test coverage and evaluation' },
  { name: 'area:dentally', color: 'F9D0C4', description: 'Dentally integration' },
  { name: 'area:ui', color: 'FEF2C0', description: 'Web app' },
  { name: 'area:backend', color: 'D4E5F7', description: 'Backend functions and entities' },
  { name: 'area:scribe', color: 'BFDADC', description: 'Audio capture and transcription' },
  { name: 'area:generation', color: 'E6CCFF', description: 'Note generation and safety review' },
  { name: 'area:audit', color: 'FAD8C7', description: 'Historical audit module' },
  { name: 'area:knowledge', color: 'FFF5B1', description: 'Agent Knowledge' },
  { name: 'area:infra', color: 'EDEDED', description: 'CI, deployment, tooling' },
  { name: 'status:started', color: '0052CC', description: 'Initial implementation committed' },
];

export const milestones = [
  { key: 'P1', title: 'Phase 1: Foundations, diary and patient confirmation', description: 'Authentication, Base44 backend, Dentally connection, today\'s diary, clinician selection, likely-patient engine, manual patient confirmation.' },
  { key: 'P2', title: 'Phase 2: Scribe capture', description: 'Patient permission, microphone, live transcription, Nurse Notes, autosave, session lifecycle, background capture spike.' },
  { key: 'P3', title: 'Phase 3: Note generation and review', description: 'Templates, tooth notation, source-grounded generation, safety review, review screen, approval.' },
  { key: 'P4', title: 'Phase 4: Record delivery, audit trail and failure recovery', description: 'Export or write-back to Dentally, idempotency, complete audit trail, failure recovery, reassignment.' },
  { key: 'P5', title: 'Phase 5: Agent Knowledge and learning', description: 'Versioned knowledge, approval queue, diff classification, de-identification, Google Drive structure.' },
  { key: 'P6', title: 'Phase 6: Historical audit', description: 'Audit runs, clinician dashboard, case review, trends.' },
  { key: 'P7', title: 'Phase 7: Hardening and production readiness', description: 'Security review, retention engine, tamper evidence, session security, multi-clinic, safety case sign-off.' },
];

const ac = (items) => '**Acceptance criteria**\n' + items.map((i) => `- [ ] ${i}`).join('\n');

export const issues = [
  // ---------------------------------------------------------------- Phase 1
  {
    id: 'P1-01', milestone: 'P1', labels: ['phase:1', 'area:infra', 'blocked-external'],
    title: 'Create Base44 staging and production apps and link the repository',
    body: `**Goal**: a Base44 home for the backend, set up so patient data is only ever stored under the decided hosting option.

**Decided (D2, 20 October 2026)**: Base44 standard plan, not Enterprise. On that plan Base44 stores data in the US and its terms allow app data to be used to train AI models, with no opt-out. Phase 1 stores only IDs, times and statuses; where Phase 2 keeps transcripts, nurse notes and drafts is follow-up D2a.

${ac([
  'Separate staging and production Base44 apps exist in the Aura workspace',
  'Base44 DPA accepted; the US storage and AI-training terms recorded in the DPIA (P1-14)',
  'Repository linked with `npx base44 scaffold`; `base44/.app.jsonc` not committed',
  'Function runtime and SDK import confirmed by pulling an existing AuraMail function; adapters adjusted if needed',
  'Password login disabled; Microsoft or Google single sign-on enabled',
])}`,
  },
  {
    id: 'P1-02', milestone: 'P1', labels: ['phase:1', 'area:dentally', 'blocked-external', 'security'],
    title: 'Dedicated read-only Dentally credential and sandbox access',
    body: `**Goal**: AuraNoteTaker has its own least-privilege Dentally access, separate from AuraMail's.

**Decided (D8, 20 October 2026)**: a separate key for the AuraNoteTaker app, read-only, sandbox first. Hisham enters it straight into the Base44 app's secrets; it is never sent in chat, email or issues.

${ac([
  'Sandbox credential issued and stored as a staging secret (`DENTALLY_API_TOKEN`, `DENTALLY_BASE_URL`, `DENTALLY_USER_AGENT`)',
  'Production credential with read scopes only, stored only in the production app',
  'Credential owner, scopes and rotation date recorded in the Integration row (secret name only)',
  'Nothing in the repository, browser, logs or entity rows contains the token',
])}`,
  },
  {
    id: 'P1-03', milestone: 'P1', labels: ['phase:1', 'area:dentally', 'spike'],
    title: 'Verify Dentally v1 field mapping against the sandbox',
    body: `**Goal**: replace documentation assumptions with observed behaviour before mapping clinicians and surgeries.

${ac([
  'Confirmed whether appointments\' \`practitioner_id\` matches practitioner \`id\` or \`user.id\` (AuraPortal used \`user.id\`)',
  'Confirmed rooms endpoint and \`room_id\` on appointments',
  'Confirmed patient date of birth field name and format',
  'Confirmed list and single-record response envelopes and pagination metadata',
  'Confirmed time zone of \`start_time\`, \`finish_time\` and the \`on\` filter',
  'Parser and fixtures updated; findings written into docs/dentally-integration.md',
])}`,
  },
  {
    id: 'P1-04', milestone: 'P1', labels: ['phase:1', 'area:backend', 'security', 'safety-critical'],
    title: 'Authentication via Base44 single sign-on with StaffProfile roles and clinic membership',
    body: `**Goal**: every request is tied to an individual with known roles in one clinic.

**Note**: Base44 users can edit custom fields on their own user record, so roles and clinic membership come only from \`StaffProfile\`, which only functions can write.

${ac([
  'Unauthenticated users are redirected to sign in',
  'Functions resolve the caller from the session and load their active StaffProfile by email; no profile or inactive profile is refused and audited (ACCESS_DENIED)',
  'Roles support multiple values (e.g. DENTIST and CLINIC_ADMIN)',
  'UI shows the signed-in user and role; sign out clears all patient data from screen and memory',
  'Base44 SDK analytics disabled in the client',
])}`,
  },
  {
    id: 'P1-05', milestone: 'P1', labels: ['phase:1', 'area:backend', 'area:ui'],
    title: 'Admin configuration: clinic, staff roles, clinician mapping, surgeries',
    body: `**Goal**: an administrator can configure the clinic without touching the database.

${ac([
  'Clinic settings editable by CLINIC_ADMIN (time zone, tooth notation, prediction windows)',
  'Staff profiles created, roles assigned, deactivated (audited)',
  'Clinicians imported from Dentally practitioners and mapped to staff profiles',
  'Surgeries created and mapped to Dentally rooms',
  'All changes go through functions and write audit events',
])}`,
  },
  {
    id: 'P1-06', milestone: 'P1', labels: ['phase:1', 'area:dentally', 'area:backend', 'status:started'],
    title: 'Read-only Dentally service and diary/patient functions (data-minimised)',
    body: `**Goal**: the browser gets exactly the diary data it needs and nothing else.

**Status**: client, validation, capabilities, mock and handlers implemented and tested (\`lib/dentally\`, \`lib/server/handlers.ts\`). Remaining: wire Base44 functions to a real Base44 app and the sandbox.

${ac([
  'Only GET requests possible (test enforced)',
  'Diary limited to today in the clinic time zone; returns IDs, times, names, state, reason only',
  'Patient summary limited to patients on today\'s diary; returns display name, date of birth, Dentally ID',
  'Unsupported operations (notes read/write, clinical history) return explicit unsupported results',
  'Invalid records dropped and counted, never guessed',
  'Timeouts, retries and error classes as in docs/dentally-integration.md; no response bodies in logs',
])}`,
  },
  {
    id: 'P1-07', milestone: 'P1', labels: ['phase:1', 'area:backend', 'safety-critical', 'status:started'],
    title: 'Likely-patient prediction engine with edge-case tests',
    body: `**Goal**: suggest the patient most likely in the chair, explain why, and refuse to guess when it is ambiguous.

**Status**: implemented in \`lib/core/prediction.ts\` with tests in \`lib/core/prediction.test.ts\`. Remaining: tune windows with real diary data after P1-03.

${ac([
  'Returns LIKELY (HIGH/MEDIUM), AMBIGUOUS or NONE with reasons and warnings; the screen shows the warnings in every state',
  'Two patients booked at the same time gives AMBIGUOUS with no default',
  'Previous patient still In surgery after the next appointment has started gives AMBIGUOUS',
  'Another appointment that may still be running (not completed, or In surgery) caps the suggestion at MEDIUM and the warning names it',
  'A current appointment with low confidence is shown for checking, never replaced by the next patient',
  '"In surgery" well past the expected finish is treated as possibly stale after 30 minutes and ignored after 120; a patient taken in late is measured from when they went in',
  'Patients still marked In surgery with nothing else current are shown for checking, never replaced by the next patient',
  'Two different bookings under one appointment ID are both dropped with a warning',
  'Cancelled, did-not-attend, completed and patient-less appointments are never suggested, nor are appointments already finished with in AuraNoteTaker today',
  'Different surgery lowers confidence; unrecognised Dentally state lowers confidence and warns',
  'Uses the clinic\'s prediction settings and the server\'s clock',
  'Correct across clock changes (late March and late October)',
])}`,
  },
  {
    id: 'P1-08', milestone: 'P1', labels: ['phase:1', 'area:backend', 'safety-critical', 'status:started'],
    title: 'Patient confirmation with server re-verification, patient lock and audit',
    body: `**Goal**: confirming a patient creates a session whose patient cannot change by accident.

**Status**: \`confirmPatient\`, \`recordConsent\` and \`cancelSession\` handlers and the session state machine implemented and tested. Remaining: Base44 repositories against a real app.

${ac([
  'Server re-fetches the appointment and the patient, and refuses on patient mismatch, cancelled or did-not-attend, not today, or another open session in the surgery, for the patient or for the clinician',
  'Returns the identity it verified, which is what the screen then shows',
  'Session created with locked patient, appointment snapshot and confirmation method',
  'Confirmation audit record (predicted versus chosen, plus the server\'s own prediction) written before the session exists; simultaneous confirmations leave at most one session',
  'Every session belongs to a surgery; a computer without one cannot confirm a patient',
  'Confirming a patient who declined earlier in the appointment needs an explicit, audited acknowledgement',
  'Only the person who confirmed the patient or the treating clinician, in the session\'s surgery and on the same day, can record the patient\'s answer',
  'A session with nothing recorded is closed automatically once it is from an earlier day or an hour past its appointment; a session from another surgery, an earlier day or another user offers only Cancel',
  'Session updates use optimistic concurrency',
])}`,
  },
  {
    id: 'P1-09', milestone: 'P1', labels: ['phase:1', 'area:ui', 'safety-critical', 'status:started'],
    title: 'Main clinical screen: header status, likely patient, confirm, change patient',
    body: `**Goal**: a clinician confirms the right patient in one tap without reading small print.

**Status**: implemented in demo mode (\`src/\`) with UI tests. Remaining: connected mode against staging.

${ac([
  'Header: product name, clinician, surgery, live clock, Dentally status, microphone status',
  'Likely patient card: name, DOB, Dentally ID, time, appointment type, clinician, confidence and reasons',
  'Confirm button names the patient; disabled for 1.5 s when the suggestion changes, including a quick change away and back',
  'Confirm stays disabled until Dentally has returned the name and date of birth for exactly that appointment and patient',
  'AMBIGUOUS shows each candidate with its own confirm and no default',
  'Change patient shows today\'s diary for the clinician',
  'After confirmation the session view shows the locked patient prominently, looked up by the locked patient ID, with the appointment date',
  'A computer clock more than 2 minutes out is pointed out; suggestions use the server\'s time',
  'Usable at 1280×720 with large controls; colour is never the only signal',
])}`,
  },
  {
    id: 'P1-10', milestone: 'P1', labels: ['phase:1', 'area:ui'],
    title: 'Diary refresh, Dentally status and stale/offline handling',
    body: `${ac([
  'Diary refreshes every 60 s when visible and every 5 min when hidden, plus manual refresh',
  'Header shows Connected, Stale (with age), Offline or Demo',
  'Last good diary kept in memory only and labelled stale after 2 minutes',
  'With Dentally unavailable, new sessions cannot be started and the screen says why',
  'Refresh never changes an active session',
  'Only the newest diary response is used; a slow older response never replaces a newer one',
])}`,
  },
  {
    id: 'P1-11', milestone: 'P1', labels: ['phase:1', 'area:backend', 'security', 'safety-critical', 'status:started'],
    title: 'Append-only AuditEvent and access logging',
    body: `**Status**: audit builder with per-action allowlists implemented (\`lib/core/audit.ts\`). Remaining: Base44 audit sink and a minimal viewer for CLINIC_ADMIN and AUDITOR.

${ac([
  'Diary views, patient views, confirmations, permission, cancellations and denied access are recorded',
  'Details contain only allowlisted keys with type-checked values (no names, DOB or clinical text), enforced in code',
  'Diary views are audited on the server\'s terms, at most once per person, clinician and day in each 15 minutes',
  'Entity rules deny client create, update and delete; functions append only',
])}`,
  },
  {
    id: 'P1-12', milestone: 'P1', labels: ['phase:1', 'area:infra', 'status:started'],
    title: 'CI: typecheck, tests, build, shared-code sync check, secret scan',
    body: `**Status**: workflow in \`.github/workflows/ci.yml\`. Remaining: enable branch protection requiring it.

${ac([
  'CI runs on pushes to main and on every pull request',
  'Branch protection on main requires CI and one review',
  'Pull request template includes the safety checklist',
])}`,
  },
  {
    id: 'P1-13', milestone: 'P1', labels: ['phase:1', 'governance', 'safety-critical'],
    title: 'Appoint a Clinical Safety Officer; adopt intended purpose and hazard log v0.1',
    body: `**Decided (D4, 20 October 2026)**: Jennifer Ingledew. DCB0160 asks that the CSO holds current UK professional registration (for a dental practice, GDC), has clinical experience in the setting, and has clinical risk management training for health IT. If Jennifer is not GDC-registered, she leads the DPIA and the safety work, and a registered clinician signs off as CSO.

${ac([
  'CSO confirmed against the DCB0160 requirements above, and booked on clinical safety training',
  'Intended purpose statement signed off (docs/clinical-safety.md section 3)',
  'Medical device qualification assessment recorded against the MHRA July 2026 guidance',
  'Hazard log v0.1 reviewed and scored on the DCB0129 matrix',
  'Clinical Risk Management Plan started (DCB0129 and DCB0160)',
])}`,
  },
  {
    id: 'P1-14', milestone: 'P1', labels: ['phase:1', 'governance', 'security', 'decision-needed'],
    title: 'Start the DPIA and processor due diligence (Base44, speech-to-text, LLM)',
    body: `**Decided (20 October 2026)**: Jennifer Ingledew leads (D4); Base44 standard plan, so data is stored in the US and Base44's terms allow app data to be used for AI training (D2); clinical content deleted after three months (D6). **Still open**: D3 (speech-to-text and LLM providers) and D2a (where transcripts and drafts are stored).

${ac([
  'DPIA drafted covering scribe, generation, audit module and staff monitoring',
  'Base44 DPA, sub-processors, backups and breach terms reviewed; the US transfer and the AI-training terms assessed against what Base44 will hold',
  'STT and LLM providers\' DPAs, regions, retention and training terms reviewed',
  'Privacy notice and signage drafted; permission script agreed',
  'DPIA signed off before any real patient audio (Phase 2 pilot)',
])}`,
  },
  {
    id: 'P1-15', milestone: 'P1', labels: ['phase:1', 'area:ui', 'safety-critical', 'testing'],
    title: 'Usability test of patient confirmation with clinicians and nurses',
    body: `${ac([
  'At least three clinicians and two nurses complete scripted scenarios (normal, double booking, overrun, wrong suggestion) in demo mode',
  'Time to confirm and any wrong selections recorded',
  'Findings fed back into the UI and the hazard log (H01)',
])}`,
  },

  // ---------------------------------------------------------------- Phase 2
  {
    id: 'P2-01', milestone: 'P2', labels: ['phase:2', 'safety-critical', 'decision-needed'],
    title: 'Patient permission workflow and standing preference',
    body: `**Escalation**: D7 (decline means no AI processing at all).

${ac([
  'Recording cannot start until permission is recorded as given, with who recorded it',
  'Decline ends the session with no recording and no AI processing; audited',
  'Standing preference (PatientReference) can be recorded and is shown at confirmation',
  'Test: patient declines AI scribe',
])}`,
  },
  {
    id: 'P2-02', milestone: 'P2', labels: ['phase:2', 'area:scribe'],
    title: 'Audio capture: AudioWorklet, microphone selector, level meter, device changes',
    body: `${ac([
  'Microphone permission requested only when starting a session',
  'Microphone selector remembers the device per PC',
  'Live input level meter',
  'Device removal detected immediately with an alert and a gap marker',
  'Capture and upload driven by audio frames, not timers',
])}`,
  },
  {
    id: 'P2-03', milestone: 'P2', labels: ['phase:2', 'area:scribe', 'spike', 'safety-critical'],
    title: 'Spike: background capture reliability on Aura\'s surgery PCs',
    body: `**Goal**: measured facts, not assumptions, about when browser capture keeps working.

${ac([
  'Test matrix on each surgery PC model, Chrome and Edge: tab hidden 5, 15 and 60 minutes; window minimised; another app focused; screen locked; memory pressure; OS sleep',
  'Each case records continuous capture yes/no and gap length',
  'Results written to docs/architecture.md section 6',
  'Recommendation on the desktop companion (P2-04)',
])}`,
  },
  {
    id: 'P2-04', milestone: 'P2', labels: ['phase:2', 'area:scribe', 'decision-needed'],
    title: 'Decide and, if needed, build the desktop companion (Phase 2b)',
    body: `${ac([
  'Decision recorded from P2-03 results',
  'If built: system-level capture, sleep prevention, tray recording indicator, streams to the same backend, signed installer',
])}`,
  },
  {
    id: 'P2-05', milestone: 'P2', labels: ['phase:2', 'area:scribe', 'security'],
    title: 'Speech-to-text provider abstraction and short-lived token function',
    body: `${ac([
  '\`SttProvider\` interface with at least one implementation',
  'Backend function mints a short-lived, session-scoped token; long-lived keys never reach the browser',
  'Vocabulary hints from Agent Knowledge',
  'Provider endpoint added to the production CSP',
])}`,
  },
  {
    id: 'P2-06', milestone: 'P2', labels: ['phase:2', 'area:scribe', 'spike', 'decision-needed'],
    title: 'Speech-to-text bake-off with dental vocabulary',
    body: `**Escalation**: D3.

${ac([
  'Staged recordings (no real patients) covering Palmer and FDI notation, materials, anaesthetics, negations',
  'Word error rate, notation error rate, latency and diarisation compared for the shortlist',
  'Processing region, retention and training terms confirmed',
  'Recommendation recorded',
])}`,
  },
  {
    id: 'P2-07', milestone: 'P2', labels: ['phase:2', 'area:ui', 'safety-critical'],
    title: 'Two-column scribe workspace and live transcript panel with ACTIVE indicator',
    body: `${ac([
  'Large two-column workspace (spec section 3): live transcript on the left, Nurse Notes on the right, locked patient banner across the top; columns stack on narrow screens',
  'Timestamped segments, interim and final',
  'Unmistakable ACTIVE recording indicator visible from across the surgery',
  'Gaps over 3 seconds shown inline with their cause',
  'Pause, resume and stop controls; large targets',
])}`,
  },
  {
    id: 'P2-08', milestone: 'P2', labels: ['phase:2', 'area:ui', 'safety-critical'],
    title: 'Nurse Notes panel with autosave, revisions and provenance',
    body: `${ac([
  'Large editable panel titled "Nurse Notes / Clinical Input", the right-hand column of the scribe workspace',
  'Autosave on change with saved/unsaved indicator; revisions kept; conflicting saves surfaced, never overwritten',
  'Author recorded; content marked as nurse-provenance',
  'Optional prompts for LA batch and expiry, materials, shade, isolation, lab details',
])}`,
  },
  {
    id: 'P2-09', milestone: 'P2', labels: ['phase:2', 'safety-critical'],
    title: 'Session lifecycle: patient lock, forgotten-stop warning and end-of-day close',
    body: `${ac([
  'Start, pause, resume, stop through the session state machine',
  'Warning when recording runs past the appointment or into the next patient\'s slot; never switches patient',
  'One active session per surgery, per patient and per clinician enforced',
  'Sessions still open after the clinic day are closed by a scheduled job: nothing recorded means cancelled, anything recorded means stopped and flagged for review, never discarded; each close is audited',
  'Test: dentist forgets to stop recording',
])}`,
  },
  {
    id: 'P2-10', milestone: 'P2', labels: ['phase:2', 'safety-critical'],
    title: 'Local outbox and session restore after refresh or restart',
    body: `${ac([
  'Unsent segments and nurse note revisions queued in IndexedDB and replayed in order; idempotent on the server',
  'Outbox purged on acknowledgement; 24-hour maximum age',
  'Browser refresh during treatment restores the session with its locked patient',
  'Visible indicator of unsynced data',
])}`,
  },
  {
    id: 'P2-11', milestone: 'P2', labels: ['phase:2', 'safety-critical', 'testing'],
    title: 'Failure tests: network loss, microphone disconnect, provider outage, refresh',
    body: `${ac([
  'Automated tests for each failure in docs/clinical-safety.md section 9',
  'No silent data loss in any test',
])}`,
  },
  {
    id: 'P2-12', milestone: 'P2', labels: ['phase:2', 'area:backend'],
    title: 'TranscriptSegment, NurseNote and PatientReference entities and functions',
    body: `${ac([
  'Entities created with deny-all client access rules',
  'Functions enforce session membership and status',
  'Retention class recorded per row',
])}`,
  },

  // ---------------------------------------------------------------- Phase 3
  {
    id: 'P3-01', milestone: 'P3', labels: ['phase:3', 'area:generation'],
    title: 'Template system and import of Aura\'s 97-template library',
    body: `${ac([
  'Template entity with versions and approval',
  'Aura\'s April 2026 library imported and mapped to the 21 note types in the spec',
  'Template suggested from appointment and conversation; clinician can change it',
  'Clinician review of each imported template recorded',
])}`,
  },
  {
    id: 'P3-02', milestone: 'P3', labels: ['phase:3', 'area:generation', 'safety-critical'],
    title: 'Tooth notation module (Palmer and FDI, canonical form, validators)',
    body: `**Decided (D5, 20 October 2026)**: Aura writes teeth as quadrant and number, for example UR1 for the upper right central incisor. Never tooth numbers such as 8 (US) or 11 (FDI) in the note.

${ac([
  'Parses spoken and written forms ("upper right one", "UR1", "11", "8") to a canonical form, flagging FDI and US numbers for checking',
  'Outputs UR1, UL6, LR7, LL8 style; deciduous teeth as URA to URE (to confirm with Aura\'s clinicians)',
  'Detects invalid teeth, laterality conflicts, mixed notation and mismatches with nurse notes',
  'Exhaustive unit tests including deciduous teeth',
])}`,
  },
  {
    id: 'P3-03', milestone: 'P3', labels: ['phase:3', 'area:generation', 'security', 'decision-needed'],
    title: 'LLM provider abstraction pinned to one region, with prompt versioning',
    body: `**Escalation**: D3.

${ac([
  'Bedrock (or decided provider) access pinned to the decided region; verified in CloudTrail',
  'Prompts versioned in the repository; version pinned on each generated note',
  'No-training and retention terms confirmed',
])}`,
  },
  {
    id: 'P3-04', milestone: 'P3', labels: ['phase:3', 'area:generation', 'safety-critical'],
    title: 'Source-grounded note generation with statement provenance',
    body: `${ac([
  'Every statement cites transcript segments, nurse note lines or appointment fields',
  'Template fields without support become MISSING, never filled',
  'Inference prohibited for consent, risks, medical history, radiographs, examination, diagnosis, treatment',
  'Diagnoses and plans recorded only when stated by the clinician',
])}`,
  },
  {
    id: 'P3-05', milestone: 'P3', labels: ['phase:3', 'area:generation', 'safety-critical'],
    title: 'Independent safety review pass and deterministic validators',
    body: `${ac([
  'Separate review call labels FACT, INFERENCE, MISSING INFORMATION, POSSIBLE CONTRADICTION',
  'Findings for every category in the spec section 6',
  'Deterministic checks for notation, laterality, medication and anaesthetic names, doses and batches',
  'Never silently fixes; findings only',
])}`,
  },
  {
    id: 'P3-06', milestone: 'P3', labels: ['phase:3', 'area:ui', 'safety-critical'],
    title: 'Review screen: transcript, nurse notes, draft and safety findings',
    body: `${ac([
  'Four areas visible together; selecting a statement highlights its sources',
  'Inferences highlighted; contradictions and missing items clearly marked',
  'Editing the draft is direct and fast',
])}`,
  },
  {
    id: 'P3-07', milestone: 'P3', labels: ['phase:3', 'area:ui', 'safety-critical'],
    title: 'Approval workflow',
    body: `${ac([
  'Approve & send to Dentally, Approve without sending, Return to edit, Discard draft',
  'Only the treating clinician, signed in as themselves, can approve',
  'HIGH findings must each be resolved first; no approve-all',
  'Approver and time recorded; approved notes immutable',
])}`,
  },
  {
    id: 'P3-08', milestone: 'P3', labels: ['phase:3', 'area:generation', 'safety-critical', 'testing'],
    title: 'Generation evaluation harness with adversarial synthetic encounters',
    body: `${ac([
  'Synthetic encounters for every note type with planted traps (absent consent, contradictory teeth, negated allergies, unreported radiograph, planned but not done)',
  'Metrics tracked per prompt and model version',
  'CI or release gate: no regression and zero unsupported statements in prohibited-inference categories',
  'Test: AI claims something absent from the sources',
])}`,
  },
  {
    id: 'P3-09', milestone: 'P3', labels: ['phase:3', 'safety-critical'],
    title: 'Input snapshot and late nurse edit handling',
    body: `${ac([
  'Generation records an input digest of transcript, nurse note revision and appointment snapshot',
  'Nurse edits after generation starts are detected and offered for regeneration, never lost',
  'Test: nurse edits notes while generation starts',
])}`,
  },

  // ---------------------------------------------------------------- Phase 4
  {
    id: 'P4-01', milestone: 'P4', labels: ['phase:4', 'area:dentally', 'safety-critical'],
    title: 'Approved-note export to Dentally with entry confirmation',
    body: `**Default delivery while Dentally offers no notes API.**

${ac([
  'One-click copy in Aura\'s Dentally template format, with patient name and Dentally ID shown as a final check',
  'Entered in Dentally confirmation recorded with who and when',
  'Daily list of approved notes not yet confirmed as entered',
])}`,
  },
  {
    id: 'P4-02', milestone: 'P4', labels: ['phase:4', 'area:dentally', 'safety-critical', 'blocked-external'],
    title: 'Dentally clinical note write-back via API',
    body: `**Not planned (D1, 20 October 2026)**: copy and paste into Dentally, with an entry confirmation (P4-01), is the agreed way to deliver notes. Revisit only if Dentally offers a notes API. **Escalation required before any production write.**

${ac([
  'Only via an official Dentally endpoint; never appointment notes, metadata or screen automation',
  'Behind \`writeback_mode = API\`, off by default',
  'Idempotency key per approved note; read-after-write verification; Dentally reference stored',
  'Sandbox tested; first production write signed off',
])}`,
  },
  {
    id: 'P4-03', milestone: 'P4', labels: ['phase:4', 'safety-critical'],
    title: 'Idempotency and duplicate submission protection',
    body: `${ac([
  'Repeated approve, export or send returns the first result',
  'Test: duplicate Dentally submission',
])}`,
  },
  {
    id: 'P4-04', milestone: 'P4', labels: ['phase:4', 'security'],
    title: 'Complete audit trail, transactional audit outbox and audit viewer',
    body: `${ac([
  'Each audit record is written together with the change it describes (transactional outbox), replacing Phase 1\'s write-audit-first-then-compensate approach',
  'Records who started recording, patient selected, start and stop times, who edited, what changed, who approved and when, delivery status and Dentally reference',
  'Viewer for CLINIC_ADMIN and AUDITOR; clinicians see their own sessions',
])}`,
  },
  {
    id: 'P4-05', milestone: 'P4', labels: ['phase:4', 'safety-critical', 'testing'],
    title: 'Failure recovery end-to-end: Dentally, Base44 and speech-to-text outages',
    body: `${ac([
  'Behaviour matches docs/clinical-safety.md section 9 in end-to-end tests',
  'Test: Dentally API goes offline; computer restart mid-session',
])}`,
  },
  {
    id: 'P4-06', milestone: 'P4', labels: ['phase:4', 'area:ui', 'safety-critical'],
    title: 'Explicit audited patient reassignment flow',
    body: `${ac([
  'Distinguishes "wrong patient selected" (relabel) from "next patient" (stop and start new)',
  'Requires a reason; refused while recording and after approval',
  'Test: wrong patient initially suggested; dentist changes surgery',
])}`,
  },
  {
    id: 'P4-07', milestone: 'P4', labels: ['phase:4', 'safety-critical', 'decision-needed'],
    title: 'Offline identity confirmation policy',
    body: `**Escalation**: D9. Recommendation: no new sessions while Dentally is unavailable.

${ac(['Decision recorded', 'If an offline path is approved: two identifiers, reconciliation when Dentally returns, flagged for review'])}`,
  },

  // ---------------------------------------------------------------- Phase 5
  {
    id: 'P5-01', milestone: 'P5', labels: ['phase:5', 'area:knowledge'],
    title: 'AgentKnowledge and AgentFeedback entities, versioning and approval queue',
    body: `${ac(['Versioned knowledge scoped GLOBAL, CLINIC, CLINICIAN', 'Approval queue for admin and clinical lead', 'Rollback to previous version'])}`,
  },
  {
    id: 'P5-02', milestone: 'P5', labels: ['phase:5', 'area:knowledge', 'safety-critical'],
    title: 'Draft-versus-approved diff and edit classifier',
    body: `${ac([
  'Edits classified as style, structure, terminology, abbreviation, formatting, transcription correction or clinical content',
  'Clinical content edits never become preferences',
  'Rejected AI suggestions (draft statements the clinician deleted, safety findings dismissed with a reason) recorded as de-identified AgentFeedback for the approval queue; a dismissed finding can never switch a safety check off by itself',
  'Proposals phrased as conditional rules',
  'Test: the "risks, benefits and alternatives" example never inserts the phrase without a supporting source',
])}`,
  },
  {
    id: 'P5-03', milestone: 'P5', labels: ['phase:5', 'area:knowledge', 'security'],
    title: 'De-identification pipeline with human check',
    body: `${ac(['Automated removal or rejection of identifiers and long free text', 'Human confirmation before approval', 'Test corpus of tricky identifiers'])}`,
  },
  {
    id: 'P5-04', milestone: 'P5', labels: ['phase:5', 'area:knowledge'],
    title: 'Google Drive controlled folder structure and sync (non-patient content)',
    body: `${ac(['Folder structure created with restricted access', 'Approved versions exported read-only', 'Drive edits become proposals, never live directly'])}`,
  },
  {
    id: 'P5-05', milestone: 'P5', labels: ['phase:5', 'area:knowledge', 'area:ui'],
    title: 'Clinician preferences and template improvement workflow',
    body: `${ac(['Clinicians view and propose their own preferences', 'Clinic rules win over preferences and conflicts are shown'])}`,
  },

  // ---------------------------------------------------------------- Phase 6
  {
    id: 'P6-01', milestone: 'P6', labels: ['phase:6', 'area:audit', 'decision-needed', 'blocked-external'],
    title: 'Decide the notes data source for historical audit',
    body: `**Blocked**: Dentally exposes no clinical notes through its API (D1).

**Note**: AuraNoteTaker deletes its own copies after three months (D6), so without a Dentally export the audit can only cover notes made through AuraNoteTaker in the last three months.

${ac(['Source chosen: Dentally API access, official export, or AuraNoteTaker-approved notes only', 'Retention and access controls for any imported notes agreed'])}`,
  },
  {
    id: 'P6-02', milestone: 'P6', labels: ['phase:6', 'area:audit'],
    title: 'Audit run engine with a NotesSource interface',
    body: `${ac(['Filters: clinician, date range, treatment type, patient, severity', 'Findings for each category in spec section 10', 'Model and prompt versions pinned per run', 'Never modifies records'])}`,
  },
  {
    id: 'P6-03', milestone: 'P6', labels: ['phase:6', 'area:audit', 'area:ui'],
    title: 'Clinician audit dashboard and case review statuses',
    body: `${ac(['Metrics per clinician as in spec section 11', 'Case view with original note, context, issue, explanation, severity', 'Statuses: UNREVIEWED, ACCEPTED FINDING, FALSE POSITIVE, ACTION REQUIRED, REVIEWED', 'Advisory language throughout'])}`,
  },
  {
    id: 'P6-04', milestone: 'P6', labels: ['phase:6', 'area:audit'],
    title: 'Trend analysis and repeated-pattern detection',
    body: `${ac(['Trends over time per clinician and clinic', 'Most commonly missing information', 'Copy-paste and template artefact detection'])}`,
  },
  {
    id: 'P6-05', milestone: 'P6', labels: ['phase:6', 'governance', 'decision-needed'],
    title: 'Staff transparency and governance for the audit module',
    body: `**Escalation**: D10.

${ac(['Visibility rules decided and implemented', 'Clinicians informed; DPIA covers staff monitoring', 'Each clinician can see their own findings'])}`,
  },

  // ---------------------------------------------------------------- Phase 7
  {
    id: 'P7-01', milestone: 'P7', labels: ['phase:7', 'security'],
    title: 'Security review and penetration test',
    body: `${ac(['Independent penetration test of web app and functions', 'High and critical findings fixed before go-live'])}`,
  },
  {
    id: 'P7-02', milestone: 'P7', labels: ['phase:7', 'security'],
    title: 'Retention policy engine, deletion jobs and legal holds',
    body: `**Decided (D6, 20 October 2026)**: AuraNoteTaker deletes its clinical content (transcripts, nurse notes, drafts, findings and its copy of approved notes) after three months; the record stays in Dentally. Audio is not stored. Audit events (no clinical content) follow their own period.

${ac(['RetentionPolicy configurable per data class, defaulting to three months for clinical content', 'Scheduled deletion with its own audit record', 'Legal hold suspends deletion', 'Deletion is built and tested before the first real transcript is stored (Phase 2 pilot), not left to Phase 7'])}`,
  },
  {
    id: 'P7-03', milestone: 'P7', labels: ['phase:7', 'security'],
    title: 'Tamper-evident audit log (hash chain)',
    body: `${ac(['Each audit event carries the previous hash', 'Verification job detects gaps or edits'])}`,
  },
  {
    id: 'P7-04', milestone: 'P7', labels: ['phase:7', 'security', 'area:ui'],
    title: 'Inactivity lock and session security on shared surgery PCs',
    body: `${ac(['Lock after configurable inactivity when no session is active', 'During recording the lock hides patient details but keeps the indicator visible', 'Unlock method decided and implemented'])}`,
  },
  {
    id: 'P7-05', milestone: 'P7', labels: ['phase:7', 'security', 'testing'],
    title: 'Cross-tenant isolation tests and multi-clinic onboarding',
    body: `${ac(['Every function tested for cross-clinic access', 'Per-clinic secrets and integrations', 'Onboarding runbook for a second clinic'])}`,
  },
  {
    id: 'P7-06', milestone: 'P7', labels: ['phase:7', 'testing'],
    title: 'Performance and all-day reliability soak test',
    body: `${ac(['Ten-hour soak on a surgery PC with diary refresh and repeated sessions', 'Memory stable; no missed refreshes beyond hidden-tab limits'])}`,
  },
  {
    id: 'P7-07', milestone: 'P7', labels: ['phase:7', 'governance', 'safety-critical'],
    title: 'Clinical safety case sign-off and go-live checklist',
    body: `${ac(['DCB0129 and DCB0160 safety case reports signed by the CSO', 'DPIA signed off', 'Staff trained', 'Go-live and rollback plan agreed'])}`,
  },
];
