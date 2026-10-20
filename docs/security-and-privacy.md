# AuraNoteTaker Pro: Security and privacy

Status: draft v0.1, 20 October 2026. This document is an engineering design, not legal advice. The Data Protection Impact Assessment (DPIA) and Aura's data protection lead must confirm the positions marked as proposals.

## 1. What we are protecting

AuraNoteTaker processes health data, which is special category personal data under UK GDPR, about patients who are often unaware of how software works. It also processes staff data and, through the audit module, information about clinicians' professional performance.

| Class | Examples | Where it may exist |
|---|---|---|
| C0 Configuration | Clinic settings, templates, vocabulary | Backend, Google Drive (Agent Knowledge), repository |
| C1 Staff | Names, emails, roles, clinician mappings | Backend |
| C2 Patient identifiers | Dentally patient and appointment IDs | Backend (sessions, audit events) |
| C3 Patient clinical content | Audio, transcripts, nurse notes, drafts, findings, approved notes, audit findings | Base44, encrypted, until the day after the session (D2a); approved notes in the controlled clinical-history shared drive in Aura's Google Workspace; speech-to-text and LLM providers in transit; the surgery PC's browser while in use |
| C4 Secrets | Dentally token, provider keys | Backend secret vault only |

Never allowed: C3 or C2 in the repository, issues, pull requests, CI logs, screenshots, test fixtures, analytics or error trackers, or anywhere in Google Drive other than the controlled clinical-history shared drive (which holds approved notes only, never transcripts or nurse notes). C4 anywhere except the secret vault.

## 2. Data flows and processors

| Party | Role | Data | Status |
|---|---|---|---|
| Dentally (Henry Schein One) | Source system of record | Reads C2 and patient display data | Existing processor for Aura |
| Base44 (Wix) | Backend: auth, database, functions | C1, C2; C3 encrypted and only until the next day (D2a) | **Decided (D2)**: standard plan. US servers; its terms allow app data to be used for AI training, which encryption of C3 is there to defeat. DPA and US transfer to be covered in the DPIA |
| Speech-to-text provider | Transcription | Live audio (C3) | **D3**: Speechmatics or AWS Transcribe, UK or EU processing, zero retention, no training |
| LLM provider | Draft and review generation | Transcripts, nurse notes, appointment snapshot (C3) | **D3**: Claude on Amazon Bedrock pinned to London (or Ireland) |
| Google (Aura's Workspace) | Agent Knowledge; controlled clinical history | C0; approved notes (C3) in the locked-down history shared drive only | Existing. Workspace terms: customer content not used to train AI without permission. Confirm the data processing terms are accepted in the admin console and check the data region |
| GitHub | Source code | Code only | Existing |

Each processor needs a signed DPA that covers special category data, a sub-processor list with locations, retention and deletion terms, a statement that customer data is not used for training, breach notification terms, and evidence of certification (SOC 2 or ISO 27001). Transfers outside the UK need an adequacy route or the UK International Data Transfer Agreement or Addendum.

## 3. Lawful basis, transparency and patient permission

- **Lawful basis** (proposal for the DPIA): documentation of care is part of providing health care, typically relying on Article 9(2)(h) alongside an Article 6 basis. The DPIA must confirm the bases for NHS and private patients separately, since Aura holds an NHS contract.
- **DPIA before any real patient audio.** New technology, special category data and systematic processing make a DPIA mandatory (Article 35). It must be completed and signed off before the Phase 2 pilot.
- **Transparency.** Update the privacy notice and add surgery and waiting-room signage explaining what is recorded, that audio is not kept, who sees the output, how long data is held, and how to say no.
- **Permission at every appointment.** The clinician or nurse asks before starting and records the answer in the app. Suggested wording: "We use an assistant that listens to the appointment and drafts my notes. I check and approve everything, and the audio isn't kept. Are you happy for it to be used today?"
- **Declining is easy and complete.** A decline ends the session with no recording and no AI processing of that appointment. A standing preference can be recorded so the patient is not asked again (Phase 2).
- **Subject access and objection.** Transcripts and drafts are within scope of subject access requests while retained. The retention design keeps that window short.
- **No covert recording.** Recording requires an explicit start after recorded permission, and the recording indicator is visible on screen at all times.

## 4. Roles and least privilege

A staff profile can hold more than one role (Hisham is both DENTIST and CLINIC_ADMIN). Roles come from `StaffProfile`, which only backend functions can write.

| Capability | SUPER_ADMIN | CLINIC_ADMIN | DENTIST / THERAPIST / HYGIENIST | NURSE | AUDITOR |
|---|---|---|---|---|---|
| See today's diary, confirm patient | | | Yes | Yes | |
| Record patient permission, start, pause, stop | | | Session members only | Session members only | |
| Cancel a session before anything is recorded | | Yes | Yes | Yes | |
| Write nurse notes | | | Yes | Yes | |
| Generate and edit drafts | | | Own sessions | | |
| **Approve notes** | | | **Own sessions only** | | |
| Export approved note and confirm entry in Dentally | | | Own sessions | Yes, after approval | |
| Reassign a session's patient (audited) | | | Own sessions | Yes, before recording | |
| Run audits and review findings | | | View own findings | | Yes |
| View audit trail | | Yes (metadata) | Own sessions | | Yes |
| Configure integrations, staff, surgeries | Platform only | Own clinic | | | |
| Approve Agent Knowledge changes | | With clinical lead | Propose own preferences | | |

A session's members are the person who confirmed its patient and its treating clinician. Cancelling is open more widely because it can only remove a patient link, never add one, and a session left open on another screen must not block the next patient.

SUPER_ADMIN is a platform role for multi-clinic operation. It has **no access to patient data** by default. Any break-glass access is time-limited, reasoned and audited.

## 5. Security controls

**Identity and sessions**
- Individual accounts only, through Microsoft or Google single sign-on, with multi-factor authentication enforced at the identity provider.
- Base44 stores session tokens in `localStorage` and does not offer configurable session timeouts. Mitigations: strict Content Security Policy, no third-party scripts, fonts or analytics, Base44 SDK analytics disabled, and an app-level inactivity lock on shared surgery PCs (default 10 minutes when no session is active). During a recording the lock screen hides patient details but keeps the recording indicator visible. Unlock design (single sign-on re-authentication or a staff PIN) is a Phase 7 decision.
- Roles and clinic membership are never read from the Base44 user record, because users can edit their own custom user fields.

**Authorisation and tenancy**
- Every function checks the caller's role and that they have an active profile in the app's clinic (Phase 1 serves one clinic per app, named by `CLINIC_KEY`). The clinic check inside handlers matters once one deployment serves several clinics.
- Clinical actions on a session check membership. Recording the patient's answer requires a session member, the session's surgery and the appointment's day; a refused attempt is audited (`ACCESS_DENIED`, `NOT_SESSION_MEMBER`). Transcript, nurse note and draft functions will apply the same membership rule (P2-12, P3).
- Entity access rules deny all direct client access to clinical, audit and configuration entities. Base44 makes entities fully open when no rules are defined, so every schema file sets rules explicitly and a test checks this.
- Cross-tenant access tests for every function (Phase 7).

**Encryption**
- TLS in transit everywhere. Base44 encrypts at rest and uses AWS KMS for credentials. Customer-managed keys are an Enterprise option.
- The surgery PC's local outbox (Phase 2) holds unsent transcript segments and nurse note revisions only until they are acknowledged by the backend, with a 24-hour maximum. Surgery PCs must have full-disk encryption.

**Secrets**
- Backend secret vault only, per environment and per clinic. `.env.example` lists names, never values.
- CI runs secret scanning on pushes to `main` and on every pull request. Any committed secret is treated as compromised and rotated.

**Logging and monitoring**
- Application and function logs contain codes and identifiers only, never names, dates of birth, transcript or note text. Handlers never log request bodies.
- `AuditEvent` records who did what to which session and when, with allowlisted metadata only.
- Monitoring of function error rates, Dentally availability, speech-to-text gaps and unconfirmed exports.

**Exports**
- Exports (audit findings, reports) require an authorised role and a stated purpose, are audited, and carry the requester and date.

**Development hygiene**
- Private repository, branch protection, required review. Changes to safety-critical paths (`lib/core`, `lib/server`, `base44/`) require review against the pull request safety checklist.
- Synthetic data only in fixtures, tests, issues and screenshots. Developers work in demo mode or against the Dentally sandbox. `npx base44 dev --remote` is never pointed at production.
- Dependabot and a minimal dependency footprint for the core.

## 6. Surgery PC requirements

- Managed Windows or macOS device, full-disk encryption, automatic screen lock, current operating system and browser updates.
- Chrome or Edge, centrally managed: AuraNoteTaker excluded from tab discarding or sleeping, no unmanaged extensions (an extension can read page content), no personal browser profiles.
- Operating system sleep disabled during clinic hours; exclusive microphone mode off.
- A wired or USB desk microphone rather than Bluetooth, which drops out.

## 7. Retention

**Decided (D2a and D6, 20 October 2026):** Base44 deletes clinical content the day after the session; the lasting copy of each approved note is the controlled clinical history in Aura's Google Workspace; Dentally keeps the record. The periods are configurable per clinic through `RetentionPolicy` and enforced by a scheduled deletion job that records what it deleted. Deletion must work before the first real transcript is stored (Phase 2 pilot).

| Data | Retention | Rationale |
|---|---|---|
| Audio | Not stored. If the Phase 2 spike shows a recovery buffer is needed, deleted once transcribed, 24 hours maximum | Transcript and nurse notes are sufficient inputs |
| Transcript segments, nurse notes | Until the day after the session (Base44, encrypted) | Working material; the approved note is what lasts |
| Generated drafts, safety findings | Until the day after the session (Base44, encrypted) | The draft-versus-approved lessons are captured, de-identified, at approval |
| Approved notes in Base44 | Until the day after approval (encrypted) | Copied to the clinical history and entered in Dentally |
| Clinical history (Google Workspace) | **Open:** proposed two years from each note | Continuity between visits; Dentally holds the full record |
| Audit events | Aligned with the clinical records retention period | Shows who accessed and changed what |
| Audit findings | 2 years | Supports trend review without indefinite performance files |
| Agent Knowledge | While active, plus version history | De-identified, no patient data |

Legal holds (complaints, claims) suspend deletion for the sessions concerned.

## 8. Agent Knowledge boundary

Agent Knowledge holds style, structure, vocabulary and rules. It never holds patient-identifiable content. Lessons are stored as de-identified patterns that pass automated checks and a human check before approval. Google Drive holds only non-patient content. See [agent-knowledge.md](agent-knowledge.md).

## 9. Clinician audit dashboard and staff privacy

Auditing clinicians' notes is processing of staff personal data and can feel like surveillance, particularly for self-employed associates. Before Phase 6 goes live: cover it in the DPIA, tell clinicians what is analysed and why, give each clinician access to their own findings, keep findings advisory, and restrict who sees whose dashboard. **D10** asks who should see what.

## 10. NHS and regulatory obligations

- Aura holds an NHS contract, so the annual **Data Security and Protection Toolkit** submission should list AuraNoteTaker in the information asset register and data flow map.
- NHS England's ambient scribing guidance expects a Clinical Safety Officer, DCB0160 documentation, a DPIA and mandatory human review. See [clinical-safety.md](clinical-safety.md).
- Personal data breaches likely to risk individuals' rights are reported to the ICO within 72 hours of discovery.

## 11. Incident response

1. Contain (disable the integration, revoke tokens, lock accounts).
2. Assess: clinical safety incidents go to the Clinical Safety Officer; data incidents go to the data protection lead.
3. Notify the ICO within 72 hours where required, and affected patients where the risk is high.
4. Record the incident, root cause and corrective actions; update the hazard log.
