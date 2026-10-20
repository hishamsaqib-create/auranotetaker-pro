# AuraNoteTaker Pro: Roadmap

Status: draft v0.2, 20 October 2026. The backlog is defined in `scripts/github/backlog.mjs` and published as [GitHub issues](https://github.com/hishamsaqib-create/auranotetaker-pro/issues) with `node scripts/github/create-backlog.mjs --repo hishamsaqib-create/auranotetaker-pro` (add `--update` to bring existing issues in line after editing it). Issue titles carry their IDs (for example `[P1-07]`).

## Decisions

These are the escalations the spec reserves for Hisham: clinical safety, patient identity, data loss, security, production credentials and Dentally production writes. Decisions made on 20 October 2026 are marked **Decided**.

| # | Decision | Recommendation or decision | Needed by |
|---|---|---|---|
| **D1** | Dentally offers no API to read or write clinical notes | **Decided:** copy and paste into Dentally is fine. Phase 4 delivers approved notes as a Dentally-ready copy with an "entered in Dentally" confirmation; API write-back (P4-02) is not planned. Historical audit (Phase 6) still needs a source for Dentally-native notes | Phase 4 and 6 |
| **D2** | Where patient data is stored and processed | **Decided:** Base44 standard plan, not Enterprise. On that plan Base44 stores data in the US, and its terms allow app data to be used to train AI models, with no opt-out. Phase 1 stores only IDs, times and statuses. See D2a | Before any production Dentally data reaches Base44 |
| **D2a** | Where transcripts, nurse notes and draft notes are stored, given D2 | **Decided:** Base44 holds them only until the next day, encrypted while held. Aura's Google Workspace keeps (1) Agent Knowledge: de-identified lessons on how notes are written, and (2) a controlled clinical history: each approved note filed under the Dentally patient ID, read only through the app, so the next note can draw on previous visits. Transcripts and nurse notes are not kept after the next day | Phase 2 |
| **D3** | LLM and speech-to-text providers | LLM: Claude Sonnet 4.6 on Amazon Bedrock pinned to London. STT: **decided (20 Oct 2026):** Speechmatics real-time, EU endpoint, en-GB output, Model Training switched off in the portal. A bake-off against AWS Transcribe stays optional (P2-06) | Phase 2 (STT), Phase 3 (LLM) |
| **D4** | Clinical Safety Officer and DPIA owner | **Decided:** Jennifer Ingledew. DCB0160 asks that the CSO holds current UK professional registration (GDC for a dental practice), has clinical experience in the setting and has health IT clinical risk management training. If Jennifer is not GDC-registered, she leads the DPIA and the safety work and a registered clinician signs off as CSO | Now; DPIA signed before Phase 2 pilot |
| **D5** | Tooth notation in notes | **Decided:** quadrant and number, for example UR1 (upper right central incisor), never tooth numbers such as 8 or 11. Spoken "upper right one" and written UR1 are accepted; FDI and US numbers are flagged for checking | Phase 3 |
| **D6** | Retention periods | **Decided:** Base44 deletes clinical content the next day (D2a); audio is not stored; Dentally keeps the record. The clinical history in Google Workspace is kept for two years from each note. **Still open:** the audit events' period | Phase 2 (transcripts), Phase 4 (history) |
| **D7** | What "patient declines" means | No recording and no AI processing of any of that appointment's data | Phase 2 |
| **D8** | Dentally credentials | **Decided:** a separate read-only key for the AuraNoteTaker app (not AuraMail's), sandbox first. Entered by Hisham straight into the Base44 app's secrets, never sent in chat | Phase 1 integration |
| **D9** | Identity confirmation while Dentally is down | Not allowed in v1: active sessions continue, new sessions wait for Dentally | Phase 4 |
| **D10** | Who sees clinician audit dashboards | Each clinician sees their own; clinical lead and auditor see all; no league tables; clinicians informed before launch | Phase 6 |

## Blockers and API limitations

| # | Blocker | Effect | Unblocked by |
|---|---|---|---|
| B1 | ~~Build session cannot create GitHub repositories~~ | Resolved 20 October 2026: Hisham created the repository; code pushed and backlog published | Done |
| B2 | No Base44 app or credentials for AuraNoteTaker | Functions and entities written but not deployed | P1-01 after D2 |
| B3 | No Dentally credentials in the build environment | Built against a mock; field mapping unverified | P1-02, P1-03 (D8) |
| B4 | Dentally has no clinical notes endpoints | No automatic write-back; no historical audit of Dentally-native notes | D1 |
| B5 | No speech-to-text or LLM accounts | Phases 2 and 3 cannot integrate | D3 |
| L1 | Browsers do not guarantee background capture; a web page cannot stop the PC sleeping | Possible capture gaps | Phase 2 spike, device policies, desktop companion if needed |
| L2 | Base44: tokens in localStorage, no configurable session timeout, users can edit their own user fields | Extra application-level controls | Designed in (CSP, inactivity lock, roles from StaffProfile) |

## Phases

### Phase 1: Foundations, diary and patient confirmation
Goal: a signed-in clinician sees today's Dentally diary, gets an explained suggestion of the current patient, and confirms the patient into a locked session.
Exit criteria: all P1 issues closed; confirmation usability-tested; running against the Dentally sandbox in staging; CSO appointed and DPIA started.

**Done in the initial commit** (demo mode, tested): prediction engine, session state machine with patient lock and permission rules, audit builder with allowlists, read-only Dentally client with validation and mock, server handlers with re-verification, Base44 entity schemas and function entry points (not yet deployed), the main clinical screen, CI.

**Hardened after an independent safety review** (20 October 2026): the confirm card and session banner can only name the patient Dentally confirms for that appointment; confidence is capped, with the reason shown, whenever another appointment may still be running; old or out-of-place sessions offer only Cancel and abandoned ones close themselves; concurrent confirmations, audit values, diary paging and the Base44 storage adapter were tightened; predictions use the server's clock. Details in [clinical-safety.md](clinical-safety.md#12-phase-1-controls-implemented).

### Phase 2: Scribe capture
Goal: with recorded permission, live transcription plus Nurse Notes, with nothing lost.
Exit criteria: background capture spike results recorded; all failure tests pass; STT provider chosen; DPIA signed off before the pilot.

### Phase 3: Note generation and review
Goal: a source-grounded draft, an independent safety review, and an approval only the treating clinician can give.
Exit criteria: evaluation harness green with zero unsupported statements in prohibited-inference categories; templates clinician-reviewed; review screen usability-tested.

### Phase 4: Record delivery, audit trail and failure recovery
Goal: approved notes reliably reach Dentally (export now, API if D1 allows), with a complete audit trail and recovery from every listed failure.

### Phase 5: Agent Knowledge and learning
Goal: AuraNoteTaker adapts to Aura's style and structure, never to clinical facts, with every change approved.

### Phase 6: Historical audit
Goal: advisory documentation audits with reviewer workflow and per-clinician dashboards, from the source chosen under D1.

### Phase 7: Hardening and production readiness
Goal: penetration-tested, retention-enforced, tamper-evident, multi-clinic-ready, with signed safety case and DPIA.

## Issues by phase

Flags: safety = safety-critical; decision = needs a decision above; blocked = external blocker; started = initial implementation committed.

#### Phase 1: Foundations, diary and patient confirmation

| ID | Issue | Flags |
|---|---|---|
| P1-01 | Create Base44 staging and production apps and link the repository | blocked |
| P1-02 | Dedicated read-only Dentally credential and sandbox access | blocked |
| P1-03 | Verify Dentally v1 field mapping against the sandbox |  |
| P1-04 | Authentication via Base44 single sign-on with StaffProfile roles and clinic membership | safety |
| P1-05 | Admin configuration: clinic, staff roles, clinician mapping, surgeries |  |
| P1-06 | Read-only Dentally service and diary/patient functions (data-minimised) | started |
| P1-07 | Likely-patient prediction engine with edge-case tests | safety, started |
| P1-08 | Patient confirmation with server re-verification, patient lock and audit | safety, started |
| P1-09 | Main clinical screen: header status, likely patient, confirm, change patient | safety, started |
| P1-10 | Diary refresh, Dentally status and stale/offline handling |  |
| P1-11 | Append-only AuditEvent and access logging | safety, started |
| P1-12 | CI: typecheck, tests, build, shared-code sync check, secret scan | started |
| P1-13 | Appoint a Clinical Safety Officer; adopt intended purpose and hazard log v0.1 | safety |
| P1-14 | Start the DPIA and processor due diligence (Base44, speech-to-text, LLM) | decision |
| P1-15 | Usability test of patient confirmation with clinicians and nurses | safety |

#### Phase 2: Scribe capture

| ID | Issue | Flags |
|---|---|---|
| P2-01 | Patient permission workflow and standing preference | safety, decision |
| P2-02 | Audio capture: AudioWorklet, microphone selector, level meter, device changes |  |
| P2-03 | Spike: background capture reliability on Aura's surgery PCs | safety |
| P2-04 | Decide and, if needed, build the desktop companion (Phase 2b) | decision |
| P2-05 | Speech-to-text provider abstraction and short-lived token function |  |
| P2-06 | Speech-to-text bake-off with dental vocabulary | decision |
| P2-07 | Two-column scribe workspace and live transcript panel with ACTIVE indicator | safety |
| P2-08 | Nurse Notes panel with autosave, revisions and provenance | safety |
| P2-09 | Session lifecycle: patient lock, forgotten-stop warning and end-of-day close | safety |
| P2-10 | Local outbox and session restore after refresh or restart | safety |
| P2-11 | Failure tests: network loss, microphone disconnect, provider outage, refresh | safety |
| P2-12 | TranscriptSegment, NurseNote and PatientReference entities and functions |  |

#### Phase 3: Note generation and review

| ID | Issue | Flags |
|---|---|---|
| P3-01 | Template system and import of Aura's 97-template library |  |
| P3-02 | Tooth notation module (Palmer and FDI, canonical form, validators) | safety |
| P3-03 | LLM provider abstraction pinned to one region, with prompt versioning | decision |
| P3-04 | Source-grounded note generation with statement provenance | safety |
| P3-05 | Independent safety review pass and deterministic validators | safety |
| P3-06 | Review screen: transcript, nurse notes, draft and safety findings | safety |
| P3-07 | Approval workflow | safety |
| P3-08 | Generation evaluation harness with adversarial synthetic encounters | safety |
| P3-09 | Input snapshot and late nurse edit handling | safety |

#### Phase 4: Record delivery, audit trail and failure recovery

| ID | Issue | Flags |
|---|---|---|
| P4-01 | Approved-note export to Dentally with entry confirmation | safety |
| P4-02 | Dentally clinical note write-back via API | safety, blocked |
| P4-03 | Idempotency and duplicate submission protection | safety |
| P4-04 | Complete audit trail, transactional audit outbox and audit viewer |  |
| P4-05 | Failure recovery end-to-end: Dentally, Base44 and speech-to-text outages | safety |
| P4-06 | Explicit audited patient reassignment flow | safety |
| P4-07 | Offline identity confirmation policy | safety, decision |
| P4-08 | Controlled clinical history in Aura's Google Workspace | safety |

#### Phase 5: Agent Knowledge and learning

| ID | Issue | Flags |
|---|---|---|
| P5-01 | AgentKnowledge and AgentFeedback entities, versioning and approval queue |  |
| P5-02 | Draft-versus-approved diff and edit classifier | safety |
| P5-03 | De-identification pipeline with human check |  |
| P5-04 | Google Drive controlled folder structure and sync (non-patient content) |  |
| P5-05 | Clinician preferences and template improvement workflow |  |

#### Phase 6: Historical audit

| ID | Issue | Flags |
|---|---|---|
| P6-01 | Decide the notes data source for historical audit | decision, blocked |
| P6-02 | Audit run engine with a NotesSource interface |  |
| P6-03 | Clinician audit dashboard and case review statuses |  |
| P6-04 | Trend analysis and repeated-pattern detection |  |
| P6-05 | Staff transparency and governance for the audit module | decision |

#### Phase 7: Hardening and production readiness

| ID | Issue | Flags |
|---|---|---|
| P7-01 | Security review and penetration test |  |
| P7-02 | Retention policy engine, deletion jobs and legal holds |  |
| P7-03 | Tamper-evident audit log (hash chain) |  |
| P7-04 | Inactivity lock and session security on shared surgery PCs |  |
| P7-05 | Cross-tenant isolation tests and multi-clinic onboarding |  |
| P7-06 | Performance and all-day reliability soak test |  |
| P7-07 | Clinical safety case sign-off and go-live checklist | safety |
