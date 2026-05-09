# Mass Tort OS (MTOS) — User Manual

A complete, item-by-item guide to every page in the CRM. Pages appear here in the same order as the left sidebar, so you can use this as a click-through reference.

---

## How to read this manual

Each entry follows the same structure:

- **What it is** — a one-line plain-English description.
- **When to use it** — the typical job-to-be-done.
- **What you can do here** — the buttons/actions on the page.
- **Tips & gotchas** — pitfalls that catch new users.

A note on roles: most things in this CRM are gated by **role** (admin / attorney / paralegal / viewer) and by **permission**. If you don't see a button or page, that's expected — ask an admin to grant the matching permission.

---

# 1. Overview

### 1.1 Dashboard (`/`)
- **What it is**: Your home screen. KPIs (lead volume, qualification rate, signed cases, revenue), a recent-activity feed, and quick links.
- **When to use it**: First thing in the morning. Mid-day check-in.
- **What you can do**: Drill into any KPI tile to land on the underlying list (e.g. clicking "New leads today" opens the leads list pre-filtered).
- **Tips**: Numbers are firm-scoped — you only ever see your own firm's data.

### 1.2 Pipeline (`/pipeline`)
- **What it is**: Kanban board of cases by status (Intake → Qualified → Retained → In Treatment → In Litigation → Settled / Closed).
- **When to use it**: Weekly pipeline review with attorneys. Spotting bottlenecks.
- **What you can do**: Drag a case card across columns to change status. Click a card for the full case detail.
- **Tips**: Status changes are audited — every move logs who/when/why.

### 1.3 Analytics (`/analytics`)
- **What it is**: Deep reporting — funnel conversion, source ROI, paralegal throughput, time-to-qualification, cost-per-acquired-case.
- **When to use it**: Monthly review. Source-of-truth for lead-buy budget decisions.
- **What you can do**: Filter by date range, tort, source, paralegal. Export to CSV.

---

# 2. Leads & Cases

### 2.1 Leads (`/leads`)
- **What it is**: The master list of every lead, with filters for tort, status, source, qualification, paralegal owner, and date.
- **When to use it**: Daily — find a specific lead, work the queue, bulk-assign.
- **What you can do**: Search, filter, click into a lead, bulk-assign, export.
- **Tips**: The "qualification" column comes from the Decision Engine — green means auto-qualified, amber means held for review, red means auto-rejected.

### 2.2 New Intake (`/leads/new`)
- **What it is**: Manual intake form — useful when a lead arrives by phone or email.
- **When to use it**: Walk-ins, referrals, or anything not coming through a web form.
- **What you can do**: Capture contact info, tort, exposure dates, injuries, and TCPA consent. Submitting kicks off de-duplication and the qualification flow automatically.
- **Tips**: De-dup is by **email + phone within the same tort** — if it matches an existing record, you'll see a banner offering to update the existing lead instead of creating a duplicate.

### 2.3 Lead Import (`/lead-import`)
- **What it is**: Bulk CSV importer.
- **When to use it**: Onboarding from a spreadsheet, importing a vendor list.
- **What you can do**: Upload a CSV → map columns → preview → commit. Failures are reported row-by-row with reasons.
- **Tips**: Download the template CSV first. Import respects the same de-dup rules as manual intake.

### 2.4 Cases (`/cases`)
- **What it is**: List of cases (a "case" is a qualified lead that has progressed past intake).
- **When to use it**: Tracking active matters.
- **What you can do**: Filter, search, open a case for the full detail view (timeline, documents, treatments, contacts, financial summary).
- **Tips**: Use **+ New Case** at the top to manually create a case from an existing lead.

### 2.5 Job Queue (`/job-queue`)
- **What it is**: Live view of the background job processor — every async task (e-sign dispatch, fax, AI extraction, OCR, etc.) shows up here with status (queued, running, succeeded, failed, retrying).
- **When to use it**: When something "should have happened" and you want to know why it didn't.
- **What you can do**: Filter by status / job type, retry failed jobs, view error details.
- **Tips**: Failed jobs surface their full error stack — share that with support if you need help.

### 2.6 Calls (`/calls`)
- **What it is**: Voice intake call log. Every Vapi-driven intake call lands here with transcript, recording, qualification verdict, and any escalation flags.
- **When to use it**: Reviewing what the AI intake agent said, QA-ing transcripts, finding calls where the agent escalated to a human.
- **What you can do**: Listen, read the transcript, jump to the matching lead.

### 2.7 Paralegals (`/paralegals`)
- **What it is**: Roster of paralegals plus their current load and round-robin assignment settings.
- **When to use it**: When someone goes on PTO, or to rebalance load.
- **What you can do**: Toggle availability, change tort assignment, see live workload counts.
- **Tips**: When a lead qualifies, it's auto-assigned via round-robin to an available paralegal who handles that tort.

### 2.8 Review Queue (`/review-queue`)
- **What it is**: Anything the system couldn't auto-decide. Held leads, conflicting documents, AI low-confidence extractions.
- **When to use it**: Daily. This is where humans add value.
- **What you can do**: Open an item, see the system's reasoning, accept / override / reject.
- **Tips**: Every override you make is logged and feeds back into the audit trail.

---

# 3. Document Workflow

### 3.1 Web Forms (`/web-forms`)
- **What it is**: Submissions from your public-facing intake landing pages.
- **When to use it**: Watching live submissions, debugging a specific form's traffic.
- **What you can do**: View raw submission, see TrustedForm cert, replay a failed lead-creation, check TCPA consent text snapshot.

### 3.2 Buyers (`/buyers`)
- **What it is**: Configuration of outbound lead **buyers** — third parties you sell unqualified leads to. Each buyer has filters, max-price, and a webhook URL.
- **When to use it**: When you sign on a new lead buyer, or to adjust pricing/criteria.
- **What you can do**: Add/edit/remove a buyer, enable or pause, see send history.

### 3.3 Doc Templates (`/document-templates`)
- **What it is**: HIPAA releases, retainer agreements, medical-record requests — the document templates you send to clients.
- **When to use it**: Adding a new template, updating language for compliance.
- **What you can do**: Create a template, edit merge tags (`{{client.first_name}}`, `{{tort.name}}`, etc.), preview, archive.

### 3.4 Assignment Matrix (`/template-assignments`)
- **What it is**: A grid mapping **template × tort × event** — e.g. "When a lead qualifies for AFFF, send the AFFF retainer."
- **When to use it**: When you add a new tort or new template and need to wire up auto-dispatch.
- **What you can do**: Click a cell to assign/unassign. Saved assignments are picked up by the Auto-Document Workflow.

### 3.5 Workflow Settings (`/workflow-settings`)
- **What it is**: Per-firm choice of which **provider** to use for each communication category — voice (Vapi/Retell/etc.), SMS (Telnyx/Twilio/etc.), email (SendGrid/Mailgun/etc.), fax (SrFax/Telnyx/etc.), e-sign (Dropbox Sign/DocuSign), and LLM (OpenAI/Anthropic/Gemini/etc.).
- **When to use it**: Once at setup, then any time you want to swap providers.
- **What you can do**: Use the picker for each category. The CRM will read whichever credentials you've stored in **Integrations** for the chosen provider.
- **Tips**: If a chosen LLM provider returns an error mid-run, the system falls back to Anthropic Claude automatically so workflows don't dead-stop.

---

# 4. Automation

### 4.1 Automations (`/automations`)
- **What it is**: An n8n-style visual workflow editor (drag nodes onto a canvas, connect them with arrows). 37+ node types covering triggers, logic, data transforms, CRM actions, integrations, AI, scripts (JS / Python / Bash / PowerShell), and IO.
- **When to use it**: Building any custom flow — "when a lead qualifies for Camp Lejeune, send a fax to the VA, then SMS the client, then create a calendar event for the attorney."
- **What you can do**:
  - Drag nodes from the catalog onto the canvas.
  - Connect output handles (e.g. `success` / `error` / `branch_a`) to the next node.
  - Click a node to edit its config in the side panel.
  - **AI Assistant** drawer: describe a workflow in English; it proposes a graph, then you can edit.
  - Run / test runs / view run history.
  - Import/export JSON.
- **Tips**: Every run is recorded with timing per node. If a node fails, the run lands in the Review Queue rather than dead-letter.

### 4.2 n8n / API Setup (`/n8n-setup`)
- **What it is**: Setup helper if you want to use **external** n8n (or any HTTP automation tool) against the CRM. Generates API keys, lists every event you can subscribe to, and shows the webhook signing scheme.
- **When to use it**: Connecting an external automation tool, or building your own integration.
- **What you can do**: Create an API key with scoped permissions, copy webhook URL + signing secret, view event catalog.

### 4.3 Self-Heal (Auto-Fix) (`/self-heal`)
- **What it is**: An AI agent that watches for repeated failures (e.g. an OCR job failing the same way 5 times) and proposes a fix. You approve or reject.
- **When to use it**: When you see recurring errors in the Job Queue.
- **What you can do**: Review proposed fixes, message the agent for clarification, approve / reject.
- **Tips**: Self-Heal **never** ships a change unapproved — humans always have the last word.

### 4.4 Competitive Intel (`/competitive-intel`) — *new*
- **What it is**: Google Ads Transparency Center lookup via SerpAPI. See what other plaintiff firms are advertising for.
- **When to use it**: Spot-checking competitors. Building a watchlist of firms to track over time. Spotting new MDLs (if a competitor suddenly starts advertising for a chemical you've never heard of, that's a signal).
- **What you can do**:
  - **Lookup tab**: Search by firm name → get current ad creatives, regions targeted, first/last seen dates.
  - **Watchlist tab**: Pin advertisers; click **Refresh** to re-snapshot. Audit log only fires when ad-count changes (no spam).
- **Tips**: Free SerpAPI plan = 100 lookups/month. Watch your usage if you have many advertisers on the list.

### 4.5 Form API Directory (`/forms-api`)
- **What it is**: Public-facing API docs for the embeddable form engine. Useful for your web team / vendors.
- **When to use it**: When someone asks "how do I embed a form on our marketing site?"
- **What you can do**: Copy the embed snippet, browse field types, view validation rules.

---

# 5. Documents

### 5.1 Documents (`/documents`)
- **What it is**: The file vault. Every uploaded document with SHA-256 integrity hash, tort association, case association, and source (manual upload / fax inbound / e-sign return / AI extraction artifact).
- **When to use it**: Finding a specific document, downloading bundles for a case.
- **What you can do**: Search, filter, preview, download, attach to a case, soft-delete.
- **Tips**: Documents are immutable once uploaded — edits create a new version.

### 5.2 OCR Inbox (`/ocr-inbox`)
- **What it is**: Documents waiting on OCR + extraction. Inbound faxes, scanned uploads.
- **When to use it**: Triaging the inbound mail pile.
- **What you can do**: Approve auto-extracted fields, correct errors, route to a case.

### 5.3 Doc Review (`/doc-review`)
- **What it is**: Side-by-side document + extracted-fields review. The QA layer over OCR/AI extraction.
- **When to use it**: When the system flags low confidence on a medical record's date-of-service or diagnosis.
- **What you can do**: Click extracted text → see the source bounding box on the PDF; correct values inline.

### 5.4 Drafting AI (`/drafting`)
- **What it is**: AI-assisted drafting of letters, demands, discovery responses. Draws on the case file and your firm's templates.
- **When to use it**: First-draft generation. **Always** human-reviewed before sending.
- **What you can do**: Pick a case, pick a template type, generate, edit, save as draft, export to Word.
- **Tips**: The model uses your firm's tone (read from sample documents you upload). It will refuse to draft anything that asserts facts not present in the case file.

---

# 6. Tools

### 6.1 NPI Lookup (`/npi-lookup`)
- **What it is**: National Provider Identifier search (CMS NPPES registry). Free, government source.
- **When to use it**: Verifying a treating physician, finding a provider's address for medical-record requests.
- **What you can do**: Search by name, NPI, specialty, or location. Save providers to a case.

### 6.2 Form Engine (`/form-engine`)
- **What it is**: Drag-and-drop builder for TCPA / TrustedForm-compliant intake forms.
- **When to use it**: Creating a new tort campaign landing page form.
- **What you can do**: Build the form, set required fields, configure consent text, get an embed snippet, preview.
- **Tips**: TrustedForm cert is captured automatically when a user submits.

### 6.3 Decision Engine (`/decision-engine`)
- **What it is**: The deterministic rules engine that decides if a lead **qualifies** for a tort. Rules are deterministic-first — AI is only used for natural-language verification (e.g. "does this paragraph mention exposure dates?").
- **When to use it**: When you want to see *why* a lead was qualified / rejected / held.
- **What you can do**: Inspect rules, run a "what-if" against a lead, view decision logs.
- **Tips**: If you need to change the rules, use **Decision Engine Settings** (admin only).

### 6.4 Praxis AI (`/predictive`)
- **What it is**: Predictive case-value model. Given a case's facts, returns an estimated settlement range and confidence band.
- **When to use it**: Settlement strategy meetings. Triaging which cases to push first.
- **What you can do**: Pick a case → see prediction + the comparable cases the model used.
- **Tips**: This is a **decision aid**, not a decision. Always show the comparables to anyone using the number.

### 6.5 Timeline (`/timeline`)
- **What it is**: Per-case chronological view — every event (call, email, fax, status change, document, treatment) on one ribbon.
- **When to use it**: Building a chronology for a deposition or demand package.
- **What you can do**: Filter event types, export to PDF.

---

# 7. Configuration

### 7.1 Vendors (`/vendors`)
- **What it is**: External vendors you work with — record-retrieval companies, marketing agencies, lead vendors.
- **What you can do**: CRUD vendor records, attach contracts, track spend.

### 7.2 Firm Settings (`/firm-settings`)
- **What it is**: Your law firm's profile — name, address, EIN, default sender identity, branding.
- **When to use it**: Initial setup; compliance updates.
- **What you can do**: Edit firm-level info, upload logo, set default signature block.

### 7.3 Users (`/users`)
- **What it is**: User management for your firm.
- **What you can do**: Invite users, change roles (admin / attorney / paralegal / viewer), deactivate, reset MFA.
- **Tips**: You can't change your own role and you can't promote someone to admin from this page (admin elevation is a separate, audited action).

### 7.4 Integrations (`/integrations`)
- **What it is**: Credential vault. Where you paste API keys / OAuth tokens for SendGrid, Telnyx, OpenAI, Anthropic, Vapi, Retell, etc.
- **When to use it**: First-time setup of any provider; rotating a key.
- **What you can do**: Add an integration, test the connection, mark active/inactive, see which workflows use it.
- **Tips**: Credentials are encrypted at rest with `ENCRYPTION_KEY_V2`. Workflow Settings (§3.5) is where you actually **choose** which integration to use per category.

### 7.5 Billing (`/billing`)
- **What it is**: Your firm's subscription, usage (calls, AI tokens, faxes), invoices.
- **What you can do**: View current plan, see usage meters, download invoices, update payment method.

### 7.6 Compliance (`/compliance`)
- **What it is**: TCPA / HIPAA / consent compliance dashboard. Per-lead consent records, opt-outs, retention timers.
- **When to use it**: Audits. Responding to consumer-complaint inquiries.
- **What you can do**: Search a phone/email to see all consent history, export compliance reports.

### 7.7 Security (`/security`)
- **What it is**: Security control panel — token revocation, MFA enforcement, rate-limit settings, AI threat-analysis log, login history.
- **When to use it**: After an offboarding ("revoke all of Jane's tokens"), suspected breach, or just monthly hygiene.
- **What you can do**: Force-logout a user, revoke a refresh token, set MFA-required, view login attempts.

---

# 8. News

### 8.1 Tort News (`/news`)
- **What it is**: Curated mass-tort news feed (Google News / Yahoo / MarketWatch / CNBC RSS).
- **When to use it**: Morning brief. Spotting movement on a tort you handle.

### 8.2 Financial (`/financial-news`)
- **What it is**: Defendant-company financial news. Useful for settlement leverage and bankruptcy watch.
- **When to use it**: Before a major settlement negotiation.

---

# 9. BOS-OMEGA (admin only)

### 9.1 Dark Room (`/dark-room`)
- **What it is**: Admin-only diagnostic / red-team console. Used for stress-testing the system against adversarial inputs.
- **When to use it**: Rarely. Only by admins working with engineering.
- **Tips**: Actions here bypass some normal guards but are still fully audited.

---

# 10. Cross-cutting concepts

These aren't pages — they're concepts that show up everywhere.

### 10.1 Audit Log
Every meaningful action (status change, role change, document send, decision override) is written to an immutable audit log. The audit log is the source of truth for "who did what, when."

### 10.2 Background Check Hub
A **single button** on a lead/case that fans out across nine verification lanes (OFAC, CourtListener litigation history, NPI for providers, address, phone, email, conflict-of-interest, dupes, ID). Each lane reports honestly — pass / fail / unknown — without faking results.

### 10.3 File Vault
All documents live in one vault with SHA-256 hashing for integrity. Files are never overwritten — edits create new versions.

### 10.4 Conflict Resolution
When two sources disagree (e.g. lead says DOB is 1962, medical record says 1963), the system flags a conflict and routes it to the Review Queue rather than silently picking one.

### 10.5 Determinism First, AI Second
Anything that can be decided by a rule (qualification, scoring, routing) is decided by a rule. AI is only used for natural-language tasks (extraction, summarization, drafting). This is the **AI Constitution** (`/api/admin/ai-constitution`) and it governs every helper LLM in the system.

### 10.6 Bright Lines (the AI will *never* do these unattended)
- Final qualification decision
- Sending an e-sign packet
- Purchasing PACER documents
- Changing TCPA consent language
- Sending a HIPAA release
- Accepting / declining a settlement
- Mass operations across many leads/cases at once

A human always confirms these.

### 10.7 RBAC & Permissions
- **Roles**: admin, attorney, paralegal, viewer (in decreasing power).
- **Permissions** are granular (`leads:view`, `automations:execute`, `competitive_intel:manage`, etc.).
- Admin role gets every permission; others get a curated subset.
- If a button is missing, you don't have the permission — ask an admin.

### 10.8 Outbound Webhooks
Every meaningful event (`lead.created`, `case.qualified`, etc.) can be dispatched to your own webhook URL with HMAC-SHA256 signing. Configure in **n8n / API Setup**.

### 10.9 Recursive Error Fallback (planning only)
When the AI Assistant in **Automations** can't produce a valid graph on its first try, it retries up to 3 times with a perspective shift each attempt, with a hard cap (6 attempts), wall-clock budget (30s), and a circuit-breaker that bails when two consecutive attempts produce identical failures. Every attempt is logged so you can see what was tried.

---

# 11. Common workflows (cheat sheets)

### "I just got a phone lead — get them into the system."
1. **New Intake** → fill the form → Submit.
2. Lead appears in **Leads** with a Decision Engine verdict within seconds.
3. If qualified → auto-assigned to a paralegal (visible in **Paralegals**); HIPAA + retainer auto-dispatched per the **Assignment Matrix**.
4. If held → it lands in **Review Queue** for a human call.

### "A document came in by fax — where does it go?"
1. **OCR Inbox**: it's auto-OCR'd and fields extracted.
2. Low-confidence fields → **Doc Review** for QA.
3. Confirmed → attached to the matching case in **Documents**.

### "I want to alert myself when a competitor advertises for a new tort."
1. **Competitive Intel → Watchlist**: add the firm.
2. **Automations**: build a workflow with a `crm.competitive_intel_lookup` node + cron trigger + SMS/Email node.
3. Run nightly. When the `found` branch returns a new ad campaign, you get a ping.

### "I need to see why a lead was rejected."
1. Open the lead from **Leads**.
2. Scroll to the **Decision Engine** trace at the bottom — it shows every rule, pass/fail, and the AI verification output.

### "I want to onboard a new paralegal."
1. **Users**: invite by email (they receive a verification link; can't sign in until verified).
2. Once they sign in, set their role to **paralegal**.
3. **Paralegals**: configure their tort assignments and turn availability **on**.

---

*Last updated: 2026-05-09.*
