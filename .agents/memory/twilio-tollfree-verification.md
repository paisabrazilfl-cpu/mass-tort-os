---
name: Twilio toll-free verification (30032 fix)
description: How to submit a Twilio toll-free verification via API and the non-obvious validation traps that cost several attempts.
---

# Twilio toll-free verification (clearing error 30032)

`POST https://messaging.twilio.com/v1/Tollfree/Verifications` (Basic auth, account SID + auth token). SMS from an unverified toll-free fails with **30032**; the block only lifts when this verification is **approved** (multi-day carrier review — nothing shortcuts it).

## Validation traps (each cost a round-trip; errors surface ONE at a time and mislead)
- **UseCaseCategories is a fixed enum**, not free text. Valid: `TWO_FACTOR_AUTHENTICATION, ACCOUNT_NOTIFICATIONS, CUSTOMER_CARE, CHARITY_NONPROFIT, DELIVERY_NOTIFICATIONS, FRAUD_ALERT_MESSAGING, EVENTS, HIGHER_EDUCATION, K12, MARKETING, POLLING_AND_VOTING_NON_POLITICAL, POLITICAL_ELECTION_CAMPAIGNS, PUBLIC_SERVICE_ANNOUNCEMENT, SECURITY_ALERT`. Lead-intake follow-ups (confirmations, doc requests, status) = `ACCOUNT_NOTIFICATIONS` + `CUSTOMER_CARE`.
- **"Invalid use case summary" 400 is a red herring.** It persisted across two different summaries and only cleared once `BusinessType` + business-registration fields were added — it was masking the missing registration block, not a real summary problem (the "failed" summary passed unchanged later). **Lesson: don't keep rewriting the summary; look for OTHER missing required fields.**
- **Non-sole-proprietor businesses require** `BusinessType` (`PRIVATE_PROFIT|PUBLIC_PROFIT|NON_PROFIT|GOVERNMENT|SOLE_PROPRIETOR`) **+** `BusinessRegistrationNumber` (US EIN, 9-digit, hyphen optional) **+** `BusinessRegistrationAuthority=EIN` **+** `BusinessRegistrationCountry=US`. Sole proprietor skips the registration fields but carriers cap its volume/trust hard.
- **`BusinessName` must be the LEGAL registered name that matches the EIN** — the operating brand/DBA is often a *different* registered LLC. Brand/DBA goes in `BusinessWebsite`/`UseCaseSummary`; the legal entity name + EIN must be collected from the owner (never fabricate — fabricated attestation = rejection + account flag). Collect these fresh each time; do not store EIN/PII in memory.
- `MessageVolume` is an enum string (`"10","100","1,000",...`). `OptInType=WEB_FORM` needs `OptInImageUrls`.

## Editing window
Verification goes `PENDING_REVIEW` → `IN_REVIEW` within **minutes**. **Once `IN_REVIEW` it cannot be edited.** So set everything correctly at submit time — especially `OptInImageUrls`: use a **stable, always-reachable** URL (the Render `*.onrender.com` deployment), NOT the ephemeral `*.replit.dev` dev preview (it sleeps and can 404 mid-review).

**Why:** the CRM's SMS path is wired to the toll-free via the integration vault; everything is configured correctly, so the only thing gating real delivery is this carrier approval.
