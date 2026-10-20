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
| H01 | Wrong patient associated with a session or note | Double booking, overrun, stale Dentally state, mis-tap, suggestion changing on screen | Suggestion only; ambiguity forces a choice with no default; confirm button names the patient; 1.5 s change guard; DOB and Dentally ID shown; server re-verifies with Dentally; predicted versus chosen audited; identity re-shown at export | `prediction.test.ts`, `handlers.test.ts`, `App.test.tsx` | H → L (after usability testing) |
| H02 | Patient changes during a session | Diary refresh, clock passing into next slot, surgery change, page refresh | Lock at creation; no transition changes the patient; reassignment explicit, reasoned, audited, refused while recording; session restored by ID from the server | `session.test.ts` | H → L |
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
| H18 | Cross-clinic data exposure | Tenancy bug | Clinic resolved from staff profile; deny-all entity rules; cross-tenant tests | `handlers.test.ts`; Phase 7 | M → L |
| H19 | Background capture silently stops | Browser throttling or discarding, operating system sleep | Capture watchdog and gap markers; device policies; Phase 2 spike; desktop companion if needed | Phase 2 spike results | H → M |
| H20 | Model or prompt change degrades notes unnoticed | Vendor model updates, prompt edits | Versions pinned per note; regression evaluation gate; CSO sign-off for changes | Phase 3 harness; change control | M → L |

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
| Overlapping appointments | Prediction returns AMBIGUOUS; the user chooses. |

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
| Patient lock, reasoned reassignment, refusal while recording and after approval | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Permission required before recording; decline terminal | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Forgotten-stop detection | `lib/core/session.ts` | `lib/core/session.test.ts` |
| Audit metadata allowlists (no clinical text in audit) | `lib/core/audit.ts` | `lib/core/audit.test.ts` |
| Read-only Dentally client; unsupported operations reported honestly | `lib/dentally/` | `lib/dentally/client.test.ts`, `lib/dentally/service.test.ts` |
| Server re-verification on confirm; one open session per surgery, patient and clinician; role and tenant checks | `lib/server/handlers.ts` | `lib/server/handlers.test.ts` |
| Every Base44 entity declares explicit deny-by-default access rules; no patient demographics stored | `base44/entities/` | `tests/base44-project.test.ts` |
| Confirm button names the patient; change guard; ambiguous state has no default | `src/` | `src/__tests__/App.test.tsx` |
