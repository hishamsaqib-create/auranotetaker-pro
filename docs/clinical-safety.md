# AuraNoteTaker Pro: Clinical safety

Status: draft v0.1, 20 October 2026. To be adopted and maintained by Aura's Clinical Safety Officer (CSO). Not legal or regulatory advice.

## 1. Purpose

This document sets out the safety position, the initial hazard log and the controls designed into AuraNoteTaker Pro. It is the seed of the Clinical Risk Management File (DCB0129 and DCB0160) and must be kept current: every release that changes clinical behaviour updates it.

## 2. Regulatory position

**MHRA guidance on ambient voice technology** (published 29 July 2026, updated 31 July 2026, [gov.uk](https://www.gov.uk/government/publications/ambient-voice-technology-enabled-products/ambient-voice-technology-enabled-products)):

- *Not* medical devices, when solely administrative: transcribing a consultation; summarising it for clinician review; turning it into structured data; suggesting codes that match explicitly mentioned terms; drafting letters from existing records. Reminders or checks for missing data are acceptable when the clinician can review and accept or reject them, provided the product does not derive or recommend new information that would affect clinical decisions.
- Medical devices: summaries with generated insights suggesting diagnoses, follow-up or treatment options; any product whose maker claims it guides diagnosis or treatment planning or improves patient outcomes; agents that act (for example order tests) without clinician review; tools that suggest diagnoses.
- Intended purpose is set by labelling, instructions and promotional material. General disclaimers do not cancel medical claims made elsewhere. Manufacturers must reassess when features change.
- The guidance does not specifically address flagging inconsistent information or auditing historical records.

**Position for AuraNoteTaker, as designed:** transcription, structuring for clinician review, missing-information and source-consistency checks the clinician accepts or rejects, and documentation-quality audit. No diagnosis, no treatment suggestions, no autonomous writes to the record. On that basis it should fall outside medical device regulation. The CSO records this qualification assessment, and it is repeated whenever a feature or a public claim changes.

Two practical consequences:

1. **Product guardrail.** The generator records diagnoses and treatment plans only when the clinician stated them. The safety engine checks documentation against its sources; it never suggests what the diagnosis or treatment should be.
2. **Marketing guardrail.** Public material (including Aura's AI-clinic messaging) must not claim AuraNoteTaker improves clinical outcomes, guides treatment or makes care safer in a clinical sense. Claims about time saved and documentation completeness are fine.

**NHS England guidance on ambient scribing** ([england.nhs.uk](https://www.england.nhs.uk/long-read/guidance-on-the-use-of-ai-enabled-ambient-scribing-products-in-health-and-care-settings/)): because Aura sees NHS patients, the deployer expectations apply: a named CSO, DCB0160 documentation (clinical safety case, hazard log, monitoring), a DPIA, transparency with patients, mandatory human review of outputs, decided retention periods, and clear liability. Pilots are limited to four months and cannot be used to bypass compliance. Because Aura is building the system itself, it is also the manufacturer, so DCB0129 manufacturer documentation applies to the build.

## 3. Intended purpose (draft for CSO sign-off)

> AuraNoteTaker Pro is an administrative documentation tool for dental teams. With the patient's permission, it transcribes the clinician–patient conversation, combines the transcript with notes entered by the dental team, and drafts a structured clinical record for the treating clinician to review, edit and approve. It checks drafts, and historical notes, for documentation completeness and consistency with their source material, and presents those checks for the clinician or reviewer to accept or reject. It does not provide diagnoses, treatment recommendations or clinical decision support, and it does not enter anything into the clinical record without the treating clinician's approval.

## 4. Safety principles

1. Never attach anything to a patient without explicit human confirmation.
2. Once a session's patient is confirmed it is locked; changes are explicit, reasoned and audited.
3. Never invent clinical facts. Not discussed and not documented means omitted or flagged as missing.
4. Never infer that consent, risk discussion, medical history checks, radiographs, examination, diagnosis or treatment happened because they normally would.
5. Never silently resolve uncertainty. Contradictions and unsupported statements are surfaced for the clinician.
6. Never silently lose clinical information. Gaps are shown as gaps.
7. Never write to the clinical record without the treating clinician's approval.
8. Never record covertly.
9. Learn style and structure, never clinical facts.
10. Audit findings are advisory, never verdicts.

## 5. Hazard log v0.1

Initial and residual risk are provisional ratings (H/M/L) for the CSO to score on the DCB0129 likelihood and severity matrix.

| ID | Hazard | Main causes | Designed controls | Verification | Initial → residual |
|---|---|---|---|---|---|
| H01 | Wrong patient associated with a session or note | Double booking, overrun, appointment not marked complete, stale Dentally state, appointment re-booked in Dentally, wrong PC clock, mis-tap, suggestion changing on screen, two screens confirming at once | Suggestion only; ambiguity forces a choice with no default; confidence capped and the possibly-running appointment named; confirm button names the patient and waits until Dentally has returned that appointment's patient and it matches; 1.5 s change guard (also on a quick change back); DOB and Dentally ID shown; server re-verifies with Dentally and returns the identity it locked; earlier decline needs acknowledgement; simultaneous confirmations leave at most one session; a patient taken in late is measured from when they went in; predictions on server time; screen, server prediction and choice audited; identity re-shown at export | `prediction.test.ts`, `handlers.test.ts`, `App.test.tsx`, `hooks.test.tsx` | H → L (after usability testing) |
| H02 | Patient changes during a session | Diary refresh, clock passing into next slot, surgery change, page refresh, appointment re-booked after confirmation | Lock at creation; no transition changes the patient; reassignment explicit, reasoned, audited, refused while recording; session restored by ID from the server and its banner looked up by the locked patient ID, with the appointment date; sessions from another surgery, an earlier day or another user offer only Cancel | `session.test.ts`, `handlers.test.ts`, `App.test.tsx` | H → L |
| H03 | Recording runs into the next patient's appointment | Forgotten stop | Overrun detection with prominent warning and stop prompt; recording indicator always visible; never auto-switches patient | `session.test.ts` (overrun detection); Phase 2 UI tests | M → L |
| H04 | AI states something that did not happen | Model fabrication; template pressure; "normally would" assumptions | Citation-required generation; unfilled template fields become MISSING; inference prohibited for consent, risks, medical history, radiographs, examination, diagnosis and treatment; independent review pass; adversarial evaluation set; clinician approval | Phase 3 evaluation harness | H → M |
| H05 | Clinically important information omitted | Long conversations; poor audio; template gaps | Required template fields flag MISSING; review pass scans the transcript for unrecorded items (allergies, complications, advice); structured nurse prompts for local anaesthetic, materials, batches | Phase 3 evaluation harness | H → M |
| H06 | Tooth notation or laterality error | Speech errors ("upper right six"), mixed Palmer and FDI, transcription of numbers | Canonical notation module; validators for invalid teeth, laterality words versus codes, consistency across the note and with nurse notes; output in the clinic's notation; HIGH severity findings | Phase 3 notation tests | H → M |
| H07 | Nurse note and transcript conflict resolved silently | Model preference for one source | Provenance kept per statement; conflicts surfaced as POSSIBLE CONTRADICTION; never auto-resolved | Phase 3 evaluation harness | M → L |
| H08 | Medication, anaesthetic or material error | Mis-hearing; dose or batch transcription | Vocabulary validation; doses and batches must match a source; nurse notes are the source for batch and expiry, conflicts flagged | Phase 3 rule tests | H → M |
| H09 | Note approved without adequate review | Automation bias, time pressure | HIGH findings must each be resolved; inferences highlighted; no bulk approve; only the treating clinician approves; sampled transcript-versus-note audits; monitoring of approval speed and edit rates; training | Phase 3 UI tests; Phase 6 monitoring | H → M |
| H10 | Clinical information lost | Network failure, refresh, crash, mic disconnect, provider outage | Local outbox with server acknowledgement; continuous nurse note autosave; session restore; gap markers; banners for every degraded state | Phase 2 failure tests | H → L |
| H11 | Duplicate or partial entry in the record | Double click, retry after timeout | Idempotency key per approved note; export status tracking; explicit entry confirmation | Phase 4 tests | M → L |
| H12 | Recording without permission | Rushed workflow | Permission step required before start; decline is terminal with no AI processing; recorded who obtained permission; visible indicator; no auto-start | `session.test.ts` | H → L |
| H13 | Learning loop learns clinical content | Diffs treated as preferences | Diff classifier excludes clinical content; only conditional phrasing rules; administrator approval; safety impact assessment for knowledge changes | Phase 5 tests | M → L |
| H14 | Wrong template shapes the note | Appointment reason does not match treatment done | Template suggestion shown and changeable; clinician confirms; irrelevant MISSING items easy to dismiss with reason | Phase 3 UI tests | M → L |
| H15 | Speech recognition error changes meaning | Negation ("no allergies"), drug names, accents | Vocabulary hints; review pass checks negations in medical history; transcript visible during review | Phase 2 bake-off; Phase 3 evaluation | H → M |
| H16 | Audit findings treated as verdicts or used punitively | Presentation, governance | Advisory labelling; reviewer workflow with false-positive status; governance decision on visibility (D10) | Phase 6 | M → L |
| H17 | Dentally outage leads to identity workaround | Pressure to keep going | No new session without verification; clear message; offline path only by decision (D9) | `handlers.test.ts` | M → L |
| H18 | Cross-clinic data exposure | Tenancy bug | Phase 1: one clinic per app (`CLINIC_KEY`) and an active StaffProfile in it required; roles never read from the user record; deny-all entity rules. Phase 7: clinic from staff profile and cross-tenant tests | `handlers.test.ts`, `base44-adapter.test.ts`; Phase 7 | M → L |
| H19 | Background capture silently stops | Browser throttling or discarding, operating system sleep | Capture watchdog and gap markers; device policies; Phase 2 spike; desktop companion if needed | Phase 2 spike results | H → M |
| H20 | Model or prompt change degrades notes unnoticed | Vendor model updates, prompt edits | Versions pinned per note; regression evaluation gate; CSO sign-off for changes | Phase 3 harness; change control | M → L |
| H21 | Audit trail incomplete or misleading | Audit write fails after a change; client-supplied audit fields; storage returns partial or malformed data | Confirmation audited before the session exists, with a compensating record if creation fails; later changes audited with retries and the user told on failure; diary-view auditing decided by the server; detail values type-checked; server's own prediction recorded; storage reads page fully and reject malformed rows; transactional outbox in Phase 4 (P4-04) | `handlers.test.ts`, `audit.test.ts`, `base44-adapter.test.ts` | M → L |

## 6. Note generation safety design (Phase 3)

Statement labels shown to the clinician:

| Label | Meaning | Allowed for |
|---|---|---|
| FACT | Stated in a source (transcript, nurse note, appointment data) | Everything |
| INFERENCE | Derived from sources but not stated (for example "local anaesthetic given" from a nurse note listing the cartridge) | Only non-prohibited content. Highlighted and must be accepted |
| MISSING INFORMATION | A template field with no supporting source | Never filled in by the model |
| POSSIBLE CONTRADICTION | Sources disagree with each other or with the draft | Must be resolved by the clinician |

Inference is prohibited for: consent, risks, benefits and alternatives discussed, medical history checked or changed, radiographs taken or reported, examination findings, diagnoses, treatment performed, and post-operative instructions given. These must be FACT or MISSING.

The worked example from the spec: if Aura's clinicians consistently prefer "Treatment options, risks, benefits and alternatives discussed. Patient understands and wishes to proceed." the system learns that *phrasing*, applied only when the transcript shows that discussion took place. When it did not, the consent field is MISSING and flagged.

## 7. Review and approval

- Transcript, nurse notes, draft and safety findings side by side; selecting a statement highlights its sources.
- HIGH findings must each be accepted, rejected or edited (with an optional note) before approval is enabled.
- No "approve all". Approval records the treating clinician and time. Only the treating clinician (the session's clinician, signed in as themselves) can approve.
- Approved notes are immutable. Corrections are addenda.

## 8. Audit module safety (Phase 6)

Findings use "possible" language, show their evidence, and default to UNREVIEWED. Dashboards show trends and rates, not league tables, and each clinician sees their own findings. Findings never change records.

## 9. Failure behaviour

| Failure | Behaviour |
|---|---|
| Dentally unavailable | Active session continues (patient already locked). New sessions blocked until identity can be verified. Diary marked stale. |
| Speech-to-text outage | Recording indicator turns amber, gap marker inserted, nurse notes continue, automatic reconnection. Never shown as "recording" when it is not. |
| Network loss | Transcript segments and nurse note revisions queue in the local outbox and replay in order when the connection returns. |
| Browser refresh or crash | Session restored from the server by ID, patient lock intact, outbox replayed. |
| Microphone disconnected | Immediate alert, gap marker, prompt to reselect a microphone. |
| Base44 unavailable | No new sessions. Active capture continues into the outbox; banner shows unsynced data. |
| Duplicate submission | Idempotency key per approved note; second attempt reports the first result. |
| Wrong patient selected | Audited reassignment before recording or while paused; after approval, an addendum process. |
| Overlapping appointments | Prediction returns AMBIGUOUS; the user chooses. An appointment that may still be running caps confidence and is named on screen. |
| Appointment re-booked in Dentally while on screen | The card shows Dentally's current patient once the diary refreshes, and its confirm waits for that patient's details. A confirm for the old patient is refused by the server and the diary is refreshed. |
| Two screens confirm at the same moment | At most one session survives: a confirmation that finds another open session after saving withdraws itself, and that screen is told and offered the open session. In an exact tie neither survives and the user confirms again. |
| Session left unused | Closed automatically once it is from an earlier day or an hour past the end of its appointment, if nothing was recorded. A session with a recording is never closed automatically in Phase 1; end-of-day handling follows in Phase 2 (P2-09). |
| Save reported as failed but went through | The session is found and withdrawn, and the audit trail says so (`CREATE_UNCONFIRMED`). |
| Surgery PC clock wrong | Suggestions use the server's time; the screen says the clock is out when it is more than 2 minutes wrong. |
| Production build without its mode set | Shows a configuration error; never falls back to the demo diary. |

## 10. Safety testing and evaluation

- **Deterministic tests** for prediction, session rules, audit allowlists, notation (Phase 3) and handlers. Required to pass in CI.
- **Generation evaluation harness** (Phase 3): synthetic encounters for every note type with planted traps (consent never discussed, tooth number contradicted by the nurse note, "no known allergies" spoken as "known allergies", a radiograph mentioned but not reported, treatment planned but not done). Metrics: unsupported statements, missed contradictions, notation errors, missed MISSING flags. Release gate: no regression against the previous version, and zero unsupported statements in the prohibited-inference categories.
- **Clinician review** of new templates and prompt versions by at least two clinicians.
- **Usability testing** of the confirmation and review screens with Aura's clinicians and nurses before go-live.

## 11. Governance

- **CSO:** a registered clinician with clinical safety training, ideally not the system's main developer or sponsor. **D4** asks who.
- **Change control:** changes to `lib/core`, `lib/server`, `base44/`, prompts, models, templates or Agent Knowledge rules carry a safety impact note in the pull request and need CSO review when clinical behaviour changes.
- **Incident reporting:** clinical safety incidents and near misses (including wrong-patient selections caught before approval) are logged and reviewed monthly.
- **Monitoring:** wrong-patient near misses (alternative chosen over a HIGH suggestion, reassignments), unresolved findings at approval, time to approve, edit rates, transcription gap minutes, exports not confirmed as entered within 24 hours.

## 12. Phase 1 controls implemented

| Control | Where | Test |
|---|---|---|
| Prediction suggests only; ambiguity returns no default | `lib/core/prediction.ts` | `lib/core/prediction.test.ts` |
| Double booking, overrun, stale In surgery, room mismatch, unknown state, cancelled and completed handling | `lib/core/prediction.ts` | `lib/core/prediction.test.ts` |
| Confidence capped and the possibly-running appointment named; a low-confidence current appointment is shown for checking, never replaced by the next patient; conflicting duplicate entries dropped; warnings shown in every state | `lib/core/prediction.ts`, `src/components/PatientConfirmation.tsx` | `lib/core/prediction.test.ts`, `src/__tests__/App.test.tsx` |
| Confirm waits for Dentally's name and DOB for exactly that appointment and patient; a different patient is a mismatch, never displayed | `src/hooks/usePatientSummaries.ts`, `src/components/PatientCard.tsx` | `src/__tests__/hooks.test.tsx`, `src/__tests__/App.test.tsx` |
| Server returns the identity it verified; session banner looked up by the locked patient ID and shows the date | `lib/server/handlers.ts` (`confirmPatient`, `getSessionPatient`), `src/components/SessionPanel.tsx` | `lib/server/handlers.test.ts`, `src/__tests__/App.test.tsx` |
| Earlier decline needs an audited acknowledgement; outcomes come from the server so a refresh never re-suggests a decline | `lib/server/handlers.ts` | `lib/server/handlers.test.ts`, `src/__tests__/App.test.tsx` |
| Consent recorded only by a session member, from the session's surgery, on the day; other sessions cancel-only; earlier-day sessions with nothing recorded closed | `lib/server/handlers.ts`, `src/components/SessionPanel.tsx` | `lib/server/handlers.test.ts`, `src/__tests__/App.test.tsx` |
| Audit first on confirmation; simultaneous confirmations leave at most one session, including when the first to confirm is the slower to save; a save reported as failed is checked and withdrawn; diary views audited by the server; detail values type-checked | `lib/server/handlers.ts`, `lib/core/audit.ts` | `lib/server/handlers.test.ts`, `lib/core/audit.test.ts` |
| A patient taken in late is measured from when they went into surgery; patients left marked In surgery are shown for checking, never replaced by the next patient | `lib/core/prediction.ts` | `lib/core/prediction.test.ts` |
| Every session belongs to a surgery; unused sessions close an hour after their appointment; restricted sessions offer Cancel only while it is allowed | `lib/server/handlers.ts`, `src/components/SessionPanel.tsx`, `src/components/Setup.tsx` | `lib/server/handlers.test.ts`, `lib/core/session.test.ts` |
| Predictions on server time with the clinic's settings; newest diary response wins; change guard holds on a quick change back | `src/hooks/useDiary.ts`, `src/hooks/useChangeGuard.ts`, `src/App.tsx` | `src/__tests__/hooks.test.tsx`, `src/__tests__/App.test.tsx` |
| Diary paging follows Dentally's page count | `lib/dentally/client.ts` | `lib/dentally/client.test.ts` |
| Storage: versioned compare-and-set writes, complete paging, malformed rows and unknown shapes rejected, no nulls written | `base44/shared/adapters/base44.ts` | `tests/base44-adapter.test.ts` |
| Production build must name its mode; connected app will not run inside a frame | `src/config.ts`, `src/main.tsx` | `src/config.test.ts` |
| Patient lock, reasoned reassignment, refusal while recording and after approval | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Permission required before recording; decline terminal | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Forgotten-stop detection | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Audit metadata allowlists (no clinical text in audit) | `lib/core/audit.ts` | `lib/core/audit.test.ts` |
| Read-only Dentally client; unsupported operations reported honestly | `lib/dentally/` | `lib/dentally/client.test.ts`, `lib/dentally/service.test.ts` |
| Server re-verification on confirm; one open session per surgery, patient and clinician; role and tenant checks | `lib/server/handlers.ts` | `lib/server/handlers.test.ts` |
| Every Base44 entity declares explicit deny-by-default access rules; no patient demographics stored | `base44/entities/` | `tests/base44-project.test.ts` |
| Confirm button names the patient; change guard; ambiguous state has no default | `src/` | `src/__tests__/App.test.tsx` |
