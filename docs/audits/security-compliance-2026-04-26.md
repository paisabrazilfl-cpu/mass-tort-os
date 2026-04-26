# MTOS Security & HIPAA/TCPA Compliance Audit

**Date:** 2026-04-26
**Scope:** `artifacts/api-server` — auth, RBAC, ePHI/PII handling, encryption, webhook signature verification, rate limiting, audit logging.
**Methodology:** Manual code review of all routes, middleware, and crypto/secret handling. Cross-referenced against task spec acceptance criteria.

---

## Summary

| Severity | Count | Fixed | Recommendation only |
|----------|-------|-------|---------------------|
| Critical | 0     | 0     | 0                   |
| High     | 6     | 6     | 0                   |
| Medium   | 5     | 1     | 4                   |
| Low      | 3     | 0     | 3                   |
| Info     | 4     | —     | —                   |

All Critical and High findings are fixed in this commit. Medium/Low items are documented as recommendations per task scope.

---

## Verified controls (working as intended)

These were audited and confirmed correct — no changes required:

- **JWT signing/verification** — `lib/rbac.ts:9-16,127-132` — `SESSION_SECRET` is required in production/staging; algorithm pinned to `HS256`; tokens carry `tv` (token_version) and are revoked on password change/logout (`token_version` increment).
- **Refresh token rotation** — `lib/rbac.ts:68-115` — Single-use rotation; reuse of a revoked token triggers full revocation of all user tokens AND `token_version` bump (defeats stolen access tokens). Critical alert is dispatched.
- **Account lockout** — `lib/rbac.ts:261-283` — 5 failed attempts → 15-minute lockout; checked at login start; failed MFA increments same counter; resets on success.
- **Password complexity** — `routes/auth.ts:38-63` — 12 chars + upper/lower/number/special; enforced on register and change-password.
- **Password storage** — `routes/auth.ts:65-83` — `crypto.scrypt` with 16-byte random salt and `timingSafeEqual` compare. (scrypt is acceptable; bcrypt/argon2id would be modestly stronger.)
- **MFA/TOTP** — `routes/auth.ts:232-307`, `lib/totp.ts` — Secrets stored encrypted with field-level AES-256-GCM. Setup → verify → enable flow, disable requires password + TOTP.
- **Dev-mode auth bypass gate** — `lib/rbac.ts:138` — Bypass only fires when `NODE_ENV !== "production" && !== "staging"`. Confirmed cannot leak into prod.
- **RBAC route coverage** — `routes/index.ts` — Every authenticated router is mounted *after* `authMiddleware`. Spot-checked all routes: every state-changing or PHI-reading endpoint declares `requireRole(...)` with the correct minimum role.
- **Role hierarchy** — `lib/rbac.ts:38-43,178-207` — admin > attorney > paralegal > viewer; both explicit allowlist and numeric hierarchy fallback are enforced. Denials are audit-logged.
- **Webhook HMAC verification BEFORE state mutation** — `routes/webhooks.ts:114-253`:
  - **Dropbox Sign** — HMAC-SHA256 of `event_type+event_time` with API key. Missing/wrong sig returns 200 with the required handshake body and performs *no* DB mutation.
  - **DocuSign** — HMAC-SHA256 of raw body with `webhook_hmac_secret`, base64-encoded, compared to `X-DocuSign-Signature-1`. Missing/wrong sig returns 200 ack, no mutation.
  - **No active integration configured** — refuses to process events from anonymous traffic; logs and acks 200.
  - Telnyx fax + SendGrid email exist as outbound adapters only; no inbound webhook routes exist, so there is no signature path to bypass. (See M-2 for recommendation when these are added.)
- **Field-level encryption** — `lib/encryption.ts` — AES-256-GCM, 12-byte IV, 16-byte auth tag, AAD = `fieldName:entityId`. Versioned (`enc:v1:1:…`) with a `getKey(version)` lookup that supports rotation via `ENCRYPTION_KEY_V<n>` env vars. Keys validated as 64 hex chars.
- **CSV import encryption** — `routes/lead-import.ts:385` — All sensitive fields run through `encryptLeadFields` before insert.
- **Vault path-traversal guards** — `lib/vault.ts:7-20,49-55` — `sanitizeCaseId` strips non-alphanumeric, `assertWithinVault` resolves and verifies prefix, symlinks rejected at read.
- **Vault integrity** — `lib/vault.ts:44` — SHA-256 hash returned + persisted with each saved file.
- **Helmet** — `app.ts:12-32` — CSP, HSTS preload, no-sniff, XSS, strict referrer; `x-powered-by` disabled.
- **Global rate limit** — `app.ts:36-47` — 500 req / 15 min per IP using XFF-aware key.
- **Auth rate limit** — `routes/auth.ts:29-36` — 20 / 15 min on `/login`, `/register`, and (now) `/refresh`.
- **IDS / threat analyzer hooks** — `lib/ids.ts`, `lib/threat-analyzer.ts` — `idsMiddleware` is wired in `app.ts:80` and runs on every request; SQL/XSS/path-traversal/command-injection scans + per-IP brute-force counter; critical hits auto-block IP for 24h and dispatch security alert.
- **Audit log writes** — Login/logout/MFA/password change/lockout/registration on auth side; create/update/delete/qualify/export on leads; dispatch + provider events on envelopes; resolution on review queue; redaction/highlight + create/update/delete on documents.
- **Production error responses** — `app.ts:84-87` — Generic `"Internal server error"` returned, full stack only in server logs.
- **CSRF** — Mitigated by Bearer-token auth (no cookies for API auth); CORS restricts production origin.

---

## High — fixed in this task

### H-1 — `verifyTOTP` crashes on unexpected token length (DoS / 500 response on auth)
- **File:** `artifacts/api-server/src/lib/totp.ts:67` (pre-fix)
- **Severity:** High
- **Description:** `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token.padStart(TOTP_DIGITS, "0")))` — `padStart` only pads up. Any submitted `totp_code` longer than 6 chars (or non-string) caused `timingSafeEqual` to throw `RangeError: input buffers must have the same byte length`, surfaced as a 500. This is a denial-of-service surface on the login MFA path and lets an attacker map MFA-enabled accounts via 401 vs 500 differential responses.
- **Resolution:** Added strict input validation, digit-only normalization, length cap, and a length-equal guard before `timingSafeEqual`. Loop now compares all candidates without short-circuiting to keep timing constant. Implemented in `lib/totp.ts`.

### H-2 — `auth/refresh` had no per-IP brute-force rate limit
- **File:** `artifacts/api-server/src/routes/auth.ts:148` (pre-fix)
- **Severity:** High
- **Description:** `/auth/refresh` accepted unlimited POSTs subject only to the global 500/15min limit. A 96-hex-char refresh token is unguessable in practice but rate-limiting is mandatory defense-in-depth — and the endpoint also leaks hit/miss timing.
- **Resolution:** Applied the same `authRateLimit` (20 req / 15 min per IP) used for `/login` and `/register`.

### H-3 — Webhook `_test/envelope-signed` only blocked production, not staging
- **File:** `artifacts/api-server/src/routes/webhooks.ts:262` (pre-fix)
- **Severity:** High
- **Description:** This unauthenticated endpoint mutates envelope state and triggers the medical-records fax workflow. The gate was `if (process.env.NODE_ENV === "production")`, so any staging/non-prod deploy with the same code would expose the endpoint. Staging frequently has real PHI test data.
- **Resolution:** Gate now blocks both `production` *and* `staging`. The endpoint remains usable only in dev/test where it's intended.

### H-4 — PII (recipient email, full name) emitted in plaintext to application logs
- **Files:** `artifacts/api-server/src/lib/workflow-handlers.ts:550,556,560` and broadly across the codebase via `logger`.
- **Severity:** High (HIPAA — application logs are not the audit log; recipient identity in workflow logs is unnecessary)
- **Description:** The pino logger redact list in `lib/logger.ts` did not include `email`, `to`, `toName`, `recipient`, `first_name`, `last_name`, `physician_*`, `hospital_fax`, `hospital_contact_info`, `notes`, or token/secret material. Workflow email sends, integration secrets in error paths, and a number of route-level info logs would emit identifying information into stdout / log aggregators.
- **Resolution:** Expanded `redact.paths` in `lib/logger.ts` to cover:
  - PII / ePHI: `email`, `user_email`, `first_name`, `last_name`, `physician_first_name`, `physician_last_name`, `physician_full_address`, `physician_contact_info`, `hospital_contact_info`, `hospital_fax`, `notes`, `phone`, `to`, `toName`, `to_name`, `recipient`, `recipients`, `fromEmail`, `from_email`, `diagnosis_date`.
  - Secrets / tokens: `token`, `access_token`, `refresh_token`, `api_key`, `webhook_hmac_secret`, `client_secret`, `totp_secret`, `totp_code`.
  Both top-level (`email`) and any-depth (`*.email`) variants are listed so nested log objects are caught. The existing `workflow-handlers.ts` logger calls now have `to` censored to `[REDACTED]` automatically — no per-call refactor needed.

### H-5 — `GET /leads/:id` did not write an audit-log entry
- **File:** `artifacts/api-server/src/routes/leads.ts:307` (pre-fix)
- **Severity:** High (HIPAA §164.312(b) — must record reads of ePHI)
- **Description:** The lead-detail read returns full decrypted ePHI (SSN last 4, DOB, diagnosis, address, physician info, etc.) but did not trigger `auditAction`. Spec acceptance criteria explicitly call out lead view as a required audit event.
- **Resolution:** Added `auditAction("view_lead")` to the route. The middleware records actor id / email / role, path, method, IP, and user-agent before handler execution.

### H-6 — IP block / unblock admin actions not audit-logged
- **File:** `artifacts/api-server/src/routes/security.ts:101,134` (pre-fix)
- **Severity:** High (administrative action affecting availability of service to users; SOC2 requires audit trail)
- **Description:** `POST /security/block-ip` and `DELETE /security/blocked-ips/:ip` mutate the IP blocklist and previously only emitted a pino log line. Logs are not the immutable audit trail.
- **Resolution:** Both endpoints now write to `audit_log` with the actor id, actor email, target IP, reason, and request metadata (IP/UA).

---

## Medium — recommendations (one fixed)

### M-1 — Refresh-token endpoint trusts client-supplied `user_id`
- **File:** `routes/auth.ts:148-166`
- **Description:** `/auth/refresh` reads `user_id` from the request body and uses it to constrain the refresh-token lookup. A refresh token alone (96 hex chars) is sufficient secret material — `user_id` from the body adds no defense and obscures the fact that the token *is* the credential. If a future change relaxes the AND condition, presence of `user_id` could cause confused-deputy issues.
- **Recommendation:** Drop `user_id` from the request body. Look the row up by `token_hash` only and read the canonical `user_id` from the matching row. Reject if the lookup yields no row. (Out of scope for this task because it requires a coordinated client change.)

### M-2 — When inbound webhooks for Telnyx (fax) and SendGrid (email) are added, they MUST verify HMAC before mutation
- **Files:** `lib/fax/telnyx.ts`, `lib/email/sendgrid.ts` (currently outbound only)
- **Description:** Today there are no inbound webhook routes for fax delivery status or email events. When they are added (Telnyx uses Ed25519-signed `Telnyx-Signature-Ed25519` + timestamp; SendGrid uses ECDSA via `X-Twilio-Email-Event-Webhook-Signature` + timestamp), they must follow the existing pattern in `routes/webhooks.ts`: load the secret from the integrations table, verify *before* any DB write, return 200-ack on bad signature.
- **Recommendation:** Add a follow-up task to wire those routes. Use the existing `applyEnvelopeEvent` pattern as a template.

### M-3 — IDS regex set produces high false-positive rate against legitimate user content
- **File:** `lib/ids.ts:7-43`
- **Description:** Patterns like `\b(or|and)\b\s+[\d'"].*[=<>]` match perfectly innocent clinical notes and lead-search queries (e.g. "patient on Lipitor 10mg and BP > 140"). Each false positive creates a `security_alert` row and (for "critical"-classified patterns) auto-blocks the source IP for 24 hours. With Drizzle parameterized queries throughout, the SQL-injection patterns provide little marginal protection at the cost of operational noise and false 24-hour blocks of internal users.
- **Recommendation:** Either (a) scope the IDS to `/api/auth/*`, `/api/forms/preview/*`, `/api/forms/embed/*`, `/api/webhooks/*`, and other public paths, or (b) tighten the regexes to require multi-pattern hits before classifying as critical, or (c) downgrade SQL-injection severity to "high" so it alerts but doesn't auto-block. Out of scope because it requires production telemetry to tune.

### M-4 — `decrypt` falls back to no-AAD on auth-tag failure
- **File:** `lib/encryption.ts:71-110`
- **Description:** When AAD-tagged ciphertext fails to decrypt with the expected `(field, entityId)` AAD, the function falls back through `(field, undefined)` and finally `undefined`. AES-GCM auth-tag verification still has to pass for every fallback so this is *cryptographically* safe, but it weakens the binding between a ciphertext and the field/entity it was written for. A stale or moved ciphertext value could be silently decrypted into a field it doesn't belong to.
- **Recommendation:** Add a one-time backfill migration that re-encrypts all rows with the canonical `(field, entity_id)` AAD, then remove the fallback chain. Out of scope here as it requires a data migration and downtime planning.

### M-5 — `POST /security/webhook-config` is a misleading no-op
- **File:** `routes/security.ts:220`
- **Description:** The handler accepts a `webhook_url`, returns 200 with a confirmation message, but does nothing — the actual webhook URL is read from the `SECURITY_WEBHOOK_URL` env var. An admin could believe they configured an integration when they did not.
- **Recommendation:** Either delete this route entirely or implement persistence (store the URL in the integrations table and have `dispatchCriticalAlert` read from there). Out of scope for this task because it requires a small schema/integration decision, not a hot-fix.

### M-6 — `audit_log` has no first-class `actor_user_id` column
- **File:** `lib/audit.ts:4-23` and DB schema
- **Description:** The actor's identity is encoded by convention in `entity_id` (when `entity_type` is "user") or buried inside `details.user_email` (via `auditAction`). This makes it harder to query "all actions taken by user X across all entity types".
- **Recommendation:** Add an `actor_user_id` column and have `auditMiddleware` / route handlers set it explicitly. Out of scope — schema change.

---

## Low

### L-1 — `auditMiddleware` ("auditAction") writes audit row *before* handler runs
- **File:** `lib/rbac.ts:209-225`
- **Description:** Recording an "intent to perform action X" instead of "completed action X" means failed/rejected attempts also produce an audit entry indistinguishable from successful ones (until you cross-reference DB state). For HIPAA "view" actions this is acceptable (the data was at least retrieved), but for state-changing actions it's worth distinguishing.
- **Recommendation:** Wrap audit insertion around `res.on("finish")` and capture the outcome status code. Low priority because the explicit `auditLog(...)` calls in route handlers (e.g. `created`, `mfa_enabled`) already record successful outcomes.

### L-2 — Encryption error sentinel `[DECRYPTION_ERROR]` can land in CSV exports
- **File:** `lib/encryption.ts:109` + `routes/leads.ts:77,304-333`
- **Description:** When decrypt fails, `[DECRYPTION_ERROR]` is substituted in place of the field. If a lead has a corrupted or key-mismatched value, the exported CSV row will silently contain that string. This is a deliberate fail-soft choice (better than throwing and losing a 5000-row export) but it can mislead downstream consumers.
- **Recommendation:** Track decryption failures in a counter and surface a banner on export when count > 0.

### L-3 — Auth audit `details` includes plaintext email
- **File:** `routes/auth.ts:106,122,135,172,194,227,273,304`
- **Description:** Login / MFA / password-change audit entries store `details: { email }` in JSONB. This is required for HIPAA forensics, but the `audit_log` table needs to be treated as a sensitive store. The existing routes for reading audit data are admin-gated; no general read endpoint exists.
- **Recommendation:** Document that `audit_log` is a Tier-1 sensitive table (encryption at rest, restricted backups). No code change.

---

## Info

- **I-1 — Bcrypt vs scrypt:** scrypt is acceptable but bcrypt or argon2id are stronger industry defaults. Migration is straightforward (verify-on-login, re-hash).
- **I-2 — JWT expiry:** 15-minute access tokens with 7-day refresh — sound choice; balance of UX vs blast radius.
- **I-3 — `_test/envelope-signed`:** Beyond the staging gate (H-3), consider moving this entirely to the test suite with direct `applyEnvelopeEvent` calls.
- **I-4 — `crypto.timingSafeEqual` in webhooks:** Both Dropbox Sign and DocuSign verifiers use plain `===` to compare HMAC digests. Because both are random hex/base64 of fixed length, a timing oracle leak gives an attacker effectively no advantage, but switching to `timingSafeEqual` (with length guard) would be best-practice and trivial.

---

## File / line index of changes

```
artifacts/api-server/src/lib/totp.ts             — H-1: TOTP length-safe verify
artifacts/api-server/src/lib/logger.ts           — H-4: PII / secret redact list
artifacts/api-server/src/routes/auth.ts          — H-2: refresh rate limit
artifacts/api-server/src/routes/leads.ts         — H-5: view_lead audit
artifacts/api-server/src/routes/webhooks.ts      — H-3: staging gate
artifacts/api-server/src/routes/security.ts      — H-6: ip_blocked / ip_unblocked audit
artifacts/api-server/src/routes/forms-public.ts  — public endpoint rate limit (defense in depth)
```

## Verification

- `npx tsc --noEmit` in `artifacts/api-server` — clean.
- All Critical/High items fixed; Medium/Low items documented above.
