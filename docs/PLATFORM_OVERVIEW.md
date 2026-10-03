# HealthBridge platform overview

Everything HealthBridge does:

- who uses it and what each role can do;
- every feature, and the step-by-step flow for each role;
- exactly where and how AI is used, and where it is deliberately not used;
- the requirements and safeguards behind it.

This page describes the platform. For running it, see [RUNNING.md](../RUNNING.md). For the
technical design, see [ARCHITECTURE.md](ARCHITECTURE.md) and the ADRs in
[DECISIONS.md](DECISIONS.md).

> Synthetic data only. HealthBridge makes no regulatory or compliance claims. Real
> patient data requires the review described in
> [ADR-0008](adr/0008-llm-usage-and-phi-policy.md).

---

## 1. What HealthBridge is

> **Consult your trusted local doctor first. Visit only when necessary.**

HealthBridge is a **continuity-of-care** platform. Patients stay connected to the local
doctors they already know and trust.

**The doctor relationship:**

- Patients add their own doctors to a care team, or accept a doctor's invitation.
- They book online or in-clinic consultations and pay online.

**Records and consent:**

- Patients keep their medical records in one place.
- They decide, record by record and doctor by doctor, who may see them.

**Consultations:**

- Doctors consult by video, write signed clinical notes and issue signed digital
  prescriptions.
- For every consultation the doctor decides whether it was handled online, needs an
  in-person visit, or is an emergency.

**Follow-up:**

- After a consultation, the patient answers short check-ins.
- Worrying answers are escalated to the doctor by fixed rules.

**AI** helps with paperwork-heavy tasks: reading lab reports, answering a doctor's
questions about a patient's records, and preparing a pre-consultation brief.

- It works only with the patient's opt-in and the doctor's consent.
- It always cites its sources.
- It never makes clinical decisions.

---

## 2. Roles

Every account has one or more roles. Permissions are explicit and checked on every
request. The database enforces patient data access a second time (row-level security).

| Role | How you get it | What it can do | What it can never do |
|---|---|---|---|
| **Patient** | Self-registration (the only role that public sign-up creates) | Manage own profile and **dependents**; choose doctors (care team); book, reschedule and cancel; pay; upload and view records; grant and revoke consent; see who accessed their records; timeline and export; answer follow-ups; prescriptions; notifications | See anyone else's data. Verify their own lab values (only a doctor can). |
| **Guardian** (a patient acting for a dependent) | Created when a patient adds a dependent (scope `manage` or `view`) | Act for the dependent within that scope: book, consent, answer check-ins (`manage`), or view only (`view`) | Act beyond the granted scope |
| **Doctor** | A patient account applies with a professional profile; a **platform admin verifies** the credentials | Availability and time off; schedule; accept or decline patients; consultations (video, SOAP notes, outcome); **sign prescriptions**; verify AI-extracted lab values; AI brief and record questions; schedule and close follow-ups; refunds for own appointments | Read any patient's records without an **active care relationship and the patient's consent**. Use AI on a patient who has not opted in. |
| **Clinic admin** | Appointed by a platform admin, **scoped to one clinic** | Invite doctors to the clinic, end memberships, view the clinic's schedule, manage clinic appointments, refunds for the clinic | See clinical records. Act outside their own clinic. |
| **Platform admin** | Provisioned (bootstrap script or by another platform admin) | Verify or reject doctors, suspend doctors; create and activate clinics, appoint clinic admins; user administration (search, disable or reinstate with a reason code, grant or remove roles, sign out everywhere); **audit log**; operations (queues, dead letters, retry) | **Any patient or clinical data.** This is deliberate: admin rights never include medical records. Grant DOCTOR or CLINIC_ADMIN directly (they come only from verification and clinic workflows). Remove the last platform admin, or their own admin role. |
| **Support** | Provisioned | Look up user accounts and appointments to help users | Change accounts, read the audit log, run operations, or see clinical data |

**Being a doctor or an administrator does not grant patient access.** None of these give
access to a patient's records on its own:

- being a doctor;
- having treated the patient before;
- working at the same clinic;
- being a clinic or platform admin;
- having an appointment with the patient.

Access needs **all three gates**:

1. **Permission:** the role allows the action. Otherwise the answer is 403.
2. **Relationship:** this user is related to this patient: self, guardian, or a doctor in
   an active care relationship. Otherwise the answer is 404, so the API does not even
   reveal that the record exists.
3. **Consent:** for doctors, an **active, unexpired consent** with the right scope
   (profile, documents, document upload) and, optionally, limited document types.
   Otherwise the answer is 403 `consent_required`.

A revoked consent blocks the **very next** request.

---

## 3. Features by area

### 3.1 Accounts and security

- **Registration** (patients only):
  - the password policy applies: 12–128 characters, a common-password deny-list, and no
    name or email inside the password;
  - the user must accept the terms;
  - the response never reveals whether an email already exists.
- **Sign-in:** a short-lived access token (10 minutes, kept in memory only) plus a
  rotating refresh cookie (httpOnly, SameSite=Strict). Refresh-token reuse is detected and
  revokes the session.
- **Lockout and limits:** 15 minutes after 5 failures, plus rate limits per IP, per
  account and per user.
- **Sessions:** list devices, sign out one device, sign out all others. Password changes
  sign out other devices; disabling an account signs it out everywhere.
- **Password reset:** emailed single-use link (30 minutes), with the token kept in the
  link fragment so it never reaches server logs. A reset signs out every device and
  lifts any lockout.
- **Email confirmation:** a link at registration, can be re-sent from the account page.
- **CSRF protection, security headers and HTTPS in production.**

### 3.2 Patient profiles and dependents

- **Profile:** basic identity and contact details only, never medical information.
  Includes an optional emergency contact.
- **Dependents** (children, older parents …): the guardian manages them with a `manage` or
  `view` scope, and can end the guardianship.

### 3.3 Doctors and verification

- **Application:** any account can create a professional profile. It includes:
  - registration number and medical council;
  - specialisations and qualifications;
  - experience, languages and a bio.
- **Verification:** submitted to the **verification queue**. A platform admin reviews it
  and verifies or rejects it with a reason code. Only verification grants the DOCTOR
  role.
- **Directory:** verified doctors appear in a public directory with their profile and
  available slots.
- **Suspension:** a platform admin can suspend a doctor.

### 3.4 Clinics

- **Creation:** platform admins create clinics, activate or deactivate them, and appoint
  clinic admins.
- **Membership:** clinic admins invite doctors; the doctor accepts or declines. The clinic
  admin can end a membership.
- **Clinic schedule:** all the clinic's appointments in one view.

### 3.5 Care relationships ("My Doctors")

- **Starting one:** the patient finds a verified doctor and sends a request, or the doctor
  invites a patient by email.
- **Lifecycle:** the other party accepts or declines. An active relationship can later be
  paused, resumed or ended.
- **Booking:** patients book only with doctors in their care team.

### 3.6 Scheduling and appointments

- **Availability:** doctors set weekly rules per mode (online or in-clinic, at a clinic):
  hours, slot length (10–120 min), validity dates and **fee**. They add time off (leave,
  conference, personal …).
- **Slots:** generated on demand from the rules, minus time off and existing bookings.
  Bookings open **30 minutes** to **60 days** ahead.
- **Booking:** includes a reason for the visit, shared only with the doctor. An idempotency
  key prevents double booking, and the database refuses overlaps for both the doctor and
  the patient.
- **Paid visits** are held for **15 minutes** while the patient pays, then released
  automatically.
- **Changes:** reschedule (creates a new appointment and refunds a paid old one in full)
  or cancel with a reason. Check-in, complete and no-show are recorded by the doctor or
  clinic.
- **Reminders:** by email and in the app, 24 hours and 1 hour before (configurable).

### 3.7 Payments

- **Providers:** **Razorpay** (live in production) or a **test provider** (development
  and demos; no money moves).
- **Confirmation:** only a **signed webhook** confirms a payment. The browser never
  decides that a payment succeeded. Duplicate or replayed webhooks change nothing.
- **Refunds:**
  - full when the doctor, clinic or system cancels, or when a visit is rescheduled;
  - full when the patient cancels **at least 24 hours** before;
  - none when the patient cancels later than that;
  - doctors and clinics can also issue manual refunds (goodwill, duplicate payment,
    other).
- **Records:** a payment ledger, and amounts shown in ₹.

### 3.8 Consent and medical records

- **Consent:** the patient grants a doctor time-limited access (up to 365 days) for a
  purpose (consultation, ongoing care, second opinion, follow-up). The patient chooses:
  - scopes: profile, documents, permission to upload;
  - optionally, specific document types.

  Consent can also be tied to one appointment, and revoked at any time with immediate
  effect.
- **Documents** (lab reports, prescriptions, imaging, discharge summaries, other):
  1. The browser uploads directly to object storage with a presigned link.
  2. The file lands in **quarantine**, gets a **virus scan** (ClamAV) and a
     **content check** (real file type, size, checksum).
  3. Only then is it **promoted** and made available.
  4. Rejected files are kept out, and the patient is told.
- **Downloads:** **short-lived signed links** (60 seconds by default), issued only after
  the access checks.
- **Retiring:** documents can be retired (hidden but never destroyed).
- **"Who accessed my records":** patients see every access to their records, taken from
  the audit trail.

### 3.9 Medical timeline

- **Contents:** one chronological history of visits, documents, verified lab results,
  prescriptions and follow-ups.
- **Provenance:** each entry is labelled "patient reported", "doctor reported" or
  "verified".
- **Visibility:** doctors see only what the patient's consent allows.
- **Export:** the patient can download the timeline as JSON.

### 3.10 Consultations and prescriptions

- **Waiting room:** for online visits, opens 15 minutes before the start. The doctor sees
  that the patient is present and starts the consultation from 10 minutes before.
- **Video:**
  - **live** with LiveKit: camera and microphone, mute, stop camera, leave;
  - a **mock** room by default in development;
  - media never passes through HealthBridge, and calls are never recorded.
- **Clinical notes (SOAP):** subjective, objective, assessment and plan.
  - Drafts are saved; signing makes a note **immutable**.
  - Corrections create a new version with a written reason.
  - Notes are **encrypted** in the database.
- **Prescriptions:**
  - items include medicine, strength, form, dose, frequency, route, duration and
    instructions, plus general advice;
  - **only the treating doctor can sign**;
  - signing seals the prescription (tamper-evident) and generates a **PDF**;
  - corrections create a new version, and the old one is kept;
  - safety rules block controlled substances in online consultations.
- **Outcome**, chosen **only by the doctor**:

  | Outcome | Meaning | What happens next |
  |---|---|---|
  | **A: managed online** | Handled online | Optional follow-up date, which schedules a check-in |
  | **B: in-person visit required** | The patient must be seen | The patient is asked to book an in-clinic visit |
  | **C: emergency** | Explicitly confirmed by the doctor | The patient is immediately shown fixed emergency guidance: **call 112 or 108**, or go to the nearest emergency department |

### 3.11 Follow-ups

- **Creation:** created from outcome A's date, or scheduled by the doctor for any day.
- **Reminders:** on the due date the patient is asked "How are you feeling?" (better,
  same or worse), with a checklist of **warning signs** and an optional note (encrypted).
  Up to **2 reminders, 48 hours apart**. With no answer after **7 days**, the doctor is
  alerted.
- **Escalation is rule-based, never AI:**
  - **any warning sign:** **urgent**; the patient immediately sees the emergency guidance
    and the doctor gets an urgent notice;
  - **"worse":** needs attention, and the doctor is notified;
  - **otherwise:** answered, no alert.
- **Closing:** the doctor reviews the answer (optionally with the AI summary, see §5) and
  closes the follow-up.

### 3.12 Notifications

- **Channels:** email (SMTP; Mailpit in development) **and** an in-app inbox with an
  unread badge, mark read and mark all read.
- **Templates:**
  - appointments: booked, cancelled, rescheduled, expired hold, reminder;
  - payments: required, confirmed, failed, refunded;
  - records: document available, document rejected, prescription available;
  - consultations: in-person visit requested, emergency guidance;
  - follow-ups: due, needs attention, urgent.
- **Wording is generic:** no symptoms, medicines, notes or diagnoses in any notification.
- **Reliability:** notifications are produced by background workers from a transactional
  outbox, so they are delayed but never lost if the queue is down.

### 3.13 Administration and operations

- **Users:**
  - search and filter accounts and view details;
  - disable or reinstate with a reason code;
  - grant or remove directly grantable roles;
  - sign a user out everywhere.
- **Audit log:**
  - covers every security-relevant and data-access event;
  - filters: category, outcome, action, user, patient, resource type, request ID and
    dates;
  - it is **append-only** (the application cannot change or delete it), and reading it is
    itself audited.
- **Operations:** outbox and queue health, failed jobs ("dead letters") with an audited
  retry. Bull Board is a read-only queue view for operators.
- **Metrics and alerts:** Prometheus metrics, alert rules and a Grafana dashboard,
  covering:
  - service health, errors and latency;
  - jobs, payments and access denials;
  - AI calls, latency, tokens and estimated cost.
- **Browser errors:** reported with the error type and page only, never content.

### 3.14 Demo mode

- **Synthetic accounts:** one per role (see [RUNNING.md](../RUNNING.md)), with doctors,
  clinics, availability, care relationships and consents ready to use.
- **Banner:** the app shows a "Demo environment" banner.
- **Not in production:** demo mode is refused there.

---

## 4. Flows by role

### 4.1 Patient

1. **Join:**
   1. Register.
   2. Optionally confirm the email.
   3. Sign in.
   4. Create a health profile (name pre-filled).
   5. Optionally add dependents.
2. **Choose doctors:** open **Doctors**, search, and send a **Request**. (Or accept a
   doctor's invitation.) The doctor accepts, and the doctor joins the care team.
3. **Book:**
   1. **Book** from the care team.
   2. Choose online or in-clinic, a day and a time, and enter a reason.
   3. Free visits are confirmed at once.
   4. Paid visits are held for 15 minutes, then the patient pays on the **payment page**.
      The visit is confirmed when the provider's webhook arrives, and the patient receives
      an email and an inbox notice.
4. **Share records (optional):**
   1. **Health Records**: upload reports (scanned automatically).
   2. **Privacy & Access**: grant the doctor consent (scopes, document types, duration).
   3. Optionally turn on **AI processing** for their records (§5).
5. **Consult:**
   1. Open the appointment → **waiting room**.
   2. When the doctor starts, **Join video**.
   3. Afterwards, see the outcome, signed notes and prescriptions (download the PDF).
6. **Follow up:** on the check-in date, answer how they feel and tick any warning signs.
   Warning signs show emergency guidance immediately.
7. **Stay in control:**
   - **Timeline** (and JSON export);
   - **Privacy & Access** to revoke consent and see who accessed the records;
   - **Account** for sessions and password;
   - **Notifications**.

### 4.2 Doctor

1. **Onboard:**
   1. Register.
   2. Create the professional profile.
   3. **Submit for verification**.
   4. After approval, the doctor workspace unlocks.
   5. Optionally accept clinic invitations.
2. **Set up practice:**
   - availability rules (online and in-clinic, fees, slot length);
   - time off.
3. **Patients:** accept or decline care requests; invite patients by email.
4. **Before a visit:**
   - open the patient's **Medical Records** (only with consent);
   - review the AI-extracted lab values and **verify** the correct ones;
   - generate the **AI brief**;
   - ask **AI record questions** with cited answers (§5).
5. **Consult:**
   1. See that the patient is in the waiting room.
   2. **Start consultation** and **Join video**.
   3. Write the SOAP note and sign it.
   4. Write the prescription and sign it (sealed PDF).
   5. Choose the **outcome**: A (with an optional follow-up date), B or C.
6. **After the visit:**
   - follow-ups list, urgent first;
   - read answers (and the optional AI summary);
   - close follow-ups;
   - correct notes or prescriptions with a reason (new versions);
   - refunds for own appointments if needed.

### 4.3 Clinic admin

1. Is appointed by a platform admin for one clinic.
2. **Clinic** page: invite doctors (the doctor accepts), see members, end memberships.
3. **Appointments:** the clinic's schedule. Manages clinic appointments (check-in,
   cancellations) and issues refunds for the clinic.
4. Never sees clinical records.

### 4.4 Platform admin

1. **Doctor Verification:** queue → start review → verify (credentials confirmed) or
   reject with a reason → suspend a doctor if needed.
2. **Clinics:** create, activate or deactivate, appoint clinic admins.
3. **Users:**
   - look up accounts;
   - disable or reinstate (reason code);
   - grant or remove roles (doctor and clinic roles only through their workflows);
   - sign users out everywhere.
4. **Audit Log:** investigate by user, patient, action, request ID or dates.
5. **Operations:** queue health, failed jobs, retry.
6. Never sees medical records.

### 4.5 Support

1. Looks up accounts and appointments to answer user questions.
2. Cannot change accounts, read the audit log, run operations or see clinical data.

### 4.6 Guardian

1. Adds a dependent from **Profile**.
2. Acts for the dependent within the granted scope:
   - booking, consent and check-ins with `manage`;
   - read-only with `view`.
3. Can end the guardianship.

---

## 5. Where and how AI is used

### 5.1 The four AI features

AI is used in **four places**, all inside a separate, internal **AI service** (Python,
FastAPI, LangGraph). Each is a **fixed workflow with no tools**: the model cannot take any
action, only return text that the backend checks.

| # | Feature | Who sees it | What it does | How it works |
|---|---|---|---|---|
| 1 | **Document intelligence** | Patient and consented doctors | Reads an uploaded report and proposes structured data: document type, report date, issuer, and **lab values** (analyte, value, unit, reference range, high/low/normal flag), each with the **exact quote** from the document | `extract text (PDF text, or OCR for scans) → classify (fast model) → extract (main model) → validate`. Validation keeps only values **found verbatim in the document** (grounding), checks numbers and dates, and flags **prompt-injection attempts** inside documents. |
| 2 | **Record questions (RAG)** | Doctor (consented) | A doctor asks a question about **one patient's** records ("What was the latest haemoglobin?") and gets a short answer with **citations** to the source documents | **Retrieval:** hybrid search (vector similarity with pgvector + keyword search) over that patient's **authorised documents and verified lab values only**, then re-ranking. The doctor's question text is never stored. **Generation:** an answer with cited sources. **Validation:** each sentence must cite a source and match its numbers; diagnostic or treatment language is removed. If nothing survives, the answer is exactly: **"Insufficient information. Please consult the doctor."** |
| 3 | **Doctor brief** | Doctor (consented) | A pre-consultation summary for an appointment, built only from the patient's **verified lab values** and **authorised document excerpts**, with every statement cited. It never uses the visit reason, unverified AI proposals, or anything outside the doctor's consent. | Gather authorised facts → generate → validate (same rules as #2). Generated on demand by the doctor, cached for 12 hours, refreshable. The doctor rates it helpful or not helpful. |
| 4 | **Follow-up summary** | Doctor only | Restates a patient's check-in answer (feeling, warning signs, note) as a short cited summary | Generate → validate. Purely informational: it runs **after** the rule-based escalation has already decided urgency, and is never shown to the patient. |

**Supporting AI pieces:**

- Document text is split into chunks and turned into **embeddings** for search: an offline
  hashing embedder by default, or Voyage AI.
- Embeddings are stored with pgvector in patient-scoped, row-level-secured tables.

### 5.2 How AI is controlled

- **The patient opts in:** AI processing is off until the patient turns it on for their
  records. The doctor also needs an active consent. No opt-in means no AI on that
  patient.
- **AI proposes, the backend validates, and humans decide:**
  - AI output is stored as **proposals** in a separate `ai` schema;
  - lab values become part of the record **only when a doctor verifies them**;
  - AI cannot write to notes, prescriptions, diagnoses, appointments, consent or records.
- **Fixed workflows, no tools:** LangGraph graphs with fixed steps and no tool calls.
  Document and source text is passed as **delimited, untrusted data**, so instructions
  hidden in a document cannot cause any action.
- **Grounding and citations:** extracted values must appear verbatim in the source. Answers
  must cite their sources and match their numbers.
- **Safety filter and fallback:**
  - AI never diagnoses, prescribes, changes treatment or contacts patients;
  - diagnostic or treatment phrasing is removed;
  - when the evidence is insufficient, the fixed fallback text is returned instead of a
    guess.
- **Patient-scoped retrieval:** every AI call carries a short-lived **scope token** for
  one patient and one purpose. The database's row-level security limits the AI service
  to that patient's authorised data.
- **Labelling:** AI content is always marked as AI-generated in the UI.
- **Logging without content:**
  - every run records metadata: model, latency, token usage, estimated cost, request ID
    and the sources used;
  - **patient medical content, prompts and outputs are never logged**;
  - Prometheus metrics carry the same metadata.

### 5.3 Models and providers

- **LLM:** a provider-neutral `LLMProvider`.
  - **Development, tests and demos:** a deterministic **fake model** (offline, free). This
    is the default.
  - **Real model:** Claude (`LLM_PROVIDER=claude`). The main model handles extraction,
    answers and briefs; a fast model handles classification.
- **Embeddings:** an offline hashing embedder by default, or Voyage AI.
- **Production gate:**
  - external AI providers (Claude, Voyage) are **refused in production** until
    `LLM_EXTERNAL_PROCESSING_APPROVED=true` is set. That setting may only follow a
    privacy, security and compliance review with contractual provider controls (ADR-0008);
  - removing names or IDs alone is **not** considered enough to make medical data safe to
    send out.

### 5.4 Where AI is deliberately not used

- **Medical decisions:** urgency and escalation of follow-ups are deterministic rules.
  The consultation outcome is the doctor's choice. Diagnoses and prescriptions are written
  and signed by the doctor.
- **Access and money:** consent, access decisions, payments and refunds.
- **Patient contact:** AI never contacts patients and never sends notifications.

---

## 6. Requirements

### 6.1 Functional

All of §3 and §4 describe the functional requirements. Their key rules:

- **Booking:** only with care-team doctors. 30 minutes' notice, up to 60 days ahead. No
  double booking. Paid holds expire after 15 minutes.
- **Payments:** confirmed only by a signed provider webhook. Idempotent. Refund rules as
  in §3.7.
- **Access:**
  - three-gate access (permission, relationship, consent) on every patient-data request;
  - revocation takes effect immediately;
  - administrators have no clinical access.
- **Clinical records:**
  - notes and prescriptions are immutable once signed;
  - corrections are new versions with a reason;
  - prescriptions are sealed and rendered as PDFs.
- **Outcomes:** only the doctor sets them. The emergency outcome shows fixed guidance
  (112/108).
- **Follow-ups:** at most 2 reminders, 48 hours apart. No-response alert after 7 days.
  Rule-based escalation.
- **AI:** opt-in only, consent-bound, cited, validated, with the exact fallback text.
  Proposals only.

### 6.2 Security and privacy

- **Passwords and tokens:** Argon2id password hashing. Short-lived Ed25519 access tokens.
  Rotating hashed refresh tokens with reuse detection. CSRF protection. Lockout and rate
  limits.
- **Encryption:** sensitive free text (clinical notes, follow-up notes) is encrypted with
  AES-256-GCM. TLS everywhere in production, including to managed databases, Redis and
  SMTP.
- **Database:** least-privilege database roles, plus **row-level security** as a second
  line of defence.
- **Audit and logs:** an append-only audit trail of all authentication, admin and
  data-access events. Logs never contain passwords, tokens or medical content.
- **Documents:** quarantine, virus scan and content validation before availability.
  Short-lived signed downloads.
- **Operator tools:** loopback-only and read-only (queue view) or audited (retries).
- **Reviews and tests:** an OWASP Top 10 review ([SECURITY_REVIEW.md](SECURITY_REVIEW.md)).
  Every API route is tested to deny anonymous access by default.

### 6.3 Quality targets (from the architecture)

| Target | Value |
|---|---|
| API latency (non-AI) | p95 under 300 ms |
| Document processing (upload → timeline) | p95 under 2 minutes (asynchronous) |
| Record-question answer | p95 under 8 s |
| Availability | 99.5% (single region) |
| Backups | RPO ≤ 15 minutes with managed point-in-time recovery in production (hourly on a single host); RTO ≤ 4 hours |

### 6.4 Running it

- **Local:** Docker Desktop (6–8 GB RAM) and Node.js 24. One command: `npm start`. See
  [RUNNING.md](../RUNNING.md).
- **Production:**
  - **single host:** Linux with Docker, a domain, TLS and an SMTP relay; or
  - **AWS:** ECS Fargate, RDS PostgreSQL 17 with pgvector, ElastiCache, S3, Secrets
    Manager, SES and an ALB.
  - Details are in [OPERATIONS.md](OPERATIONS.md).

---

## 7. Technology at a glance

| Layer | Technology |
|---|---|
| Web app | React, Vite, Tailwind CSS, TanStack Query, served by unprivileged Nginx (TLS, strict CSP) |
| API and workers | Node.js 24, Express 5 (modular monolith), Knex, Zod validation, BullMQ workers with a transactional outbox |
| AI service | Python 3.12, FastAPI, LangGraph, Claude (or the fake model), pgvector retrieval, OCR (Tesseract) |
| Data | PostgreSQL 17 + pgvector (row-level security), Redis, S3/MinIO object storage |
| Video | LiveKit (adapter; a mock provider by default) |
| Email | SMTP (Mailpit locally; SES or similar in production) |
| Payments | Razorpay, plus a test provider |
| Operations | Docker Compose, GitHub Actions CI/CD, Prometheus, Grafana, Bull Board, encrypted backups with restore drills |
| Testing | Vitest (unit and integration), Testing Library, pytest, Playwright (browser journeys, including live video) |

---

## 8. Status and known limitations

All planned milestones (M0–M12) are complete.

**Not included yet** (planned for Phase 2 in the architecture):

- **Sign-in and messaging:** two-factor login (TOTP) for doctors and admins; real SMS or
  WhatsApp delivery and notification preferences.
- **Clinic tools:** a clinic admin suite (staff rota, billing overview); real-time
  waiting-room updates; analytics dashboards; second-opinion sharing between doctors.
- **Payments:** automatic payment reconciliation and partial refunds.
- **Deployment:** the AWS production path is defined and tested as manifests but has not
  been deployed from this repository.
