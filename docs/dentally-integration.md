# AuraNoteTaker Pro: Dentally integration

Status: draft v0.1, 20 October 2026. Based on Dentally's public documentation and community answers, not yet verified against the sandbox (issue P1-03).

## 1. Summary

| Need | Dentally public API | Status |
|---|---|---|
| Today's diary, per clinician and surgery | `GET /v1/appointments` with date, practitioner, room and site filters | Supported |
| Appointment detail and state | `GET /v1/appointments/{id}` | Supported |
| Patient identity for confirmation | `GET /v1/patients/{id}` | Supported (date of birth field to verify) |
| Practitioners, rooms, sites | `GET /v1/practitioners`, `/v1/rooms`, `/v1/sites` | Practitioners and sites confirmed by existing Aura integrations; rooms to verify |
| **Read clinical notes** | None | **Not available.** Blocks Phase 6 historical audit of Dentally-native notes |
| **Write clinical notes** | None | **Not available.** Blocks Phase 4 automatic write-back |
| Patient documents, audit log, letters, chart images | None | Not available |

Dentally's community team confirmed in April 2025 that Notes, Audit, Patient documents and several other areas are not available through the API, logged the requests as feature requests, and gave no timeline ([Dentally community thread](https://community.dentally.com/integrations-api-47/endpoint-access-audit-notes-tasks-casemixes-autocorrespondence-email-letter-patientchartimage-patientdocument-patitentexemption-periobpr-textmessage-specialists-266)). Dentally staff describe the API as two-way but say write access varies by endpoint ([thread](https://community.dentally.com/integrations-api-47/is-the-dentally-api-2-way-213)). The visible v1 reference documents no notes resource ([developer.dentally.co](https://developer.dentally.co/)). The NexGen (v2) API is an early preview with Sites and Patients only ([docs.api.dentally.com](https://docs.api.dentally.com/)).

**DECISION NEEDED (D1):** ask Dentally (their API/Synapse team) for clinical notes read and write access, or their roadmap, and whether an official export of clinical notes exists. Until then the designs in sections 6 and 7 apply.

## 2. API facts we rely on

- Base URLs: production `https://api.dentally.co`, sandbox `https://api.sandbox.dentally.co`. Version prefix `/v1/`.
- A `User-Agent` header is mandatory; requests without it get `403 Forbidden`. AuraPortal uses `AuraPortal/1.0`; AuraNoteTaker will send `AuraNoteTaker/<version>`.
- JSON over REST. Lists paginate with `page` and `per_page` (default 25, maximum 100). Dentally advises keeping appointment date ranges to three months or less and not paginating past page 100.
- Scopes seen in the documentation include `user:read`, `patient:read` and `patient:update`. AuraNoteTaker requests read scopes only.
- Rate limits are not documented publicly. Polling is conservative (section 5).

### Appointment fields used

`id`, `start_time`, `finish_time`, `duration`, `state`, `practitioner_id`, `room_id`, `patient_id`, `patient_name`, `reason`, `arrived_at`, `in_surgery_at`, `completed_at`.

States: `Pending`, `Confirmed`, `Arrived`, `In surgery`, `Completed`, `Cancelled`, `Did not attend`. Any other value is mapped to `Unknown`, which caps prediction confidence and raises a warning.

Fields deliberately **not** used: `notes` (diary notes), `metadata`, `treatment_description`, `patient_image_url`. The diary needs none of them, and data minimisation says not to fetch what we do not need into the scribe path.

List filters used: `on` (date), `practitioner_id`, `room_id`, `site_id`. Cancelled appointments are excluded by default (`cancelled=false`); the parser also drops them defensively.

### Known quirks to verify in the sandbox (issue P1-03)

1. **Practitioner identifier.** AuraPortal treats `user.id` (not the practitioner's top-level `id`) as the practitioner identifier. Appointments carry both `practitioner_id` and `user_id`. Confirm which one matches the practitioner list before mapping clinicians. The `Clinician` entity stores both.
2. **Rooms endpoint and room IDs** on appointments, so surgery matching works.
3. **Patient date of birth field** name and format.
4. **Response envelope** for lists and single records (resource-named keys and pagination metadata). The parser accepts both singular and plural keys and stops paging on a short page.
5. **Time zone** of `start_time`/`finish_time` and of the `on` filter (expected: ISO 8601 with offset, `on` in practice local time).

## 3. Service abstraction (`lib/dentally`)

The spec's function names map onto the service as follows. Unsupported operations return an explicit result instead of throwing or improvising.

| Spec function | Implementation | Result today |
|---|---|---|
| `getTodaysAppointments()` | `GET /v1/appointments?on=<today>&site_id=` (all pages) | Supported |
| `getClinicianAppointments()` | Same, with `practitioner_id` | Supported |
| `getAppointment()` | `GET /v1/appointments/{id}` | Supported |
| `getPatient()` | `GET /v1/patients/{id}`, mapped to display name and date of birth only | Supported |
| `getPatientClinicalHistory()` | Not available. Phase 3 may use appointment history and treatment plan items as context once verified | Returns `{ supported: false, reason: 'NOT_AVAILABLE_IN_DENTALLY_API' }` |
| `getPatientNotes()` | Not available | Returns `{ supported: false, reason: 'NOT_AVAILABLE_IN_DENTALLY_API' }` |
| `createClinicalNote()` | Not available. **Never** emulated with appointment notes or metadata | Returns `{ supported: false, reason: 'NOT_AVAILABLE_IN_DENTALLY_API' }` |

The client exposes only GET methods. There is no generic request method, so a write cannot be added by accident. `lib/dentally/client.test.ts` asserts that every request the client can make is a GET.

## 4. Credentials

- **Dedicated credential.** AuraNoteTaker gets its own Dentally API credential with read-only scopes, rather than sharing AuraMail's. That limits blast radius and lets access be revoked or audited independently. (Escalation D8: production credentials.)
- Stored as backend secrets: `DENTALLY_API_TOKEN`, `DENTALLY_BASE_URL`, `DENTALLY_USER_AGENT`. Never in the repository, the browser, logs or entity rows. The `Integration` entity records the secret's name, not its value.
- Sandbox credentials for development and staging. Production credentials only in the production app.
- The authentication header scheme (bearer token) should be confirmed by pulling one of AuraMail's existing sync functions (`npx base44 functions pull`) before connecting.

## 5. Reliability and fallback

- Timeouts: 8 seconds per request. Retries: up to 2, with backoff and jitter, for network errors, timeouts, 429 and 502/503/504. `Retry-After` is honoured up to 5 seconds. Other 4xx errors are not retried.
- Errors are classified (`AUTH`, `NOT_FOUND`, `RATE_LIMITED`, `UNAVAILABLE`, `TIMEOUT`, `BAD_RESPONSE`) and carry no response bodies, so nothing patient-identifiable reaches logs.
- Records that fail validation are dropped and counted (the diary shows "1 appointment could not be read"), never guessed at.
- Polling: diary every 60 seconds while the page is visible, every 5 minutes while hidden, plus a manual refresh. The header shows Connected, Stale (with the age of the last good diary), Offline or Demo.
- The last good diary is held in memory only, and is labelled stale when it is more than two minutes old.
- **Dentally unavailable:** an active session continues, because its patient is already locked. A new session cannot be started, because identity cannot be verified. An offline confirmation path is a clinical safety decision (D9) and is not built until decided.

## 6. Delivering approved notes (Phase 4), given no write API

Default design, available without Dentally changes:

1. The clinician approves the note in AuraNoteTaker. The approved note is stored with its hash and approver.
2. **Export to Dentally**: one click copies the note in the format of Aura's Dentally templates (Palmer notation, section headings) and shows the patient name and Dentally ID beside it as a final identity check.
3. The clinician pastes it into the patient's clinical notes in Dentally and clicks **Entered in Dentally**. The audit trail records export time, confirmation time and who confirmed.
4. A daily list shows approved notes not yet confirmed as entered, so nothing is left behind.

If Dentally later provides a notes endpoint, `createClinicalNote()` is implemented behind the `writeback_mode = API` clinic setting, with an idempotency key per approved note, read-after-write verification, and escalation sign-off before the first production write (spec section 25).

Explicitly rejected: writing clinical content into appointment `notes` or `metadata` (diary fields visible to reception and not part of the clinical record), screen automation or scraping of the Dentally web app (forbidden by the spec), and unofficial endpoints.

## 7. Historical audit (Phase 6), given no read API

Options, in order of preference (D1):

1. **Dentally grants read access** to clinical notes. Build the audit engine against it.
2. **Official Dentally export** of clinical notes, if one exists, imported into a controlled, time-limited audit store under the retention policy.
3. **Audit AuraNoteTaker-approved notes only.** Fully possible now, but covers only notes written through the scribe.

The audit engine is built against a `NotesSource` interface so the source can change without touching the analysis.

## 8. Mock service

`lib/dentally/mock.ts` produces a fictional diary relative to the current time in the clinic's time zone, with scenarios for a normal day, a double booking, an overrun, a gap between appointments, a patient taken in early, and Dentally being offline. Identifiers are prefixed `DEMO-`. The demo diary is only ever used in demo mode, which the UI labels permanently.
