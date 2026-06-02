---
name: Email channel (SendGrid) reality
description: How outbound email actually works/delivers in MTOS, and the deliverability ceiling vs SMS 10DLC.
---

# Email channel (SendGrid)

Email is the channel that does NOT hit a carrier-vetting wall like SMS 10DLC. It is the
reliable fallback when SMS `delivery_failed`/40010 (unregistered 10DLC) blocks texts.

**State (verified):** SendGrid integration (provider `sendgrid`, category `email`) is the
configured email provider, routed via `workflow_settings.email_provider_integration_id` →
provider-router. The stored sender `from_email` is a SendGrid **verified single-sender**
(`/v3/verified_senders` → verified=true) and the API key has mail.send scope
(`/v3/scopes` → 200). Outbound email genuinely DELIVERS to a real inbox — confirmed via the
Email Activity feed showing `status=delivered` (the intake confirmation "We received your …
Claim" email delivers end-to-end).

**Accept ≠ deliver (same lesson as SMS):** the SendGrid adapter returns `ok` on the **202
accept** (with `x-message-id`), not on actual delivery. Unlike SMS, outbound email is NOT
persisted to a table (just logged via `logger.info "Workflow email sent"`), so there's no
false `status=sent` DB row — but a 202 still isn't proof of inbox arrival. Ground-truth
delivery comes from `GET /v3/messages?query=to_email="…"` (Email Activity API; can lag a few
minutes for brand-new sends, and the endpoint can hang — always use an AbortController).

**Deliverability ceiling (the real gap):** the configured `from_email` is a `@gmail.com`
address with NO domain authentication (`/v3/whitelabel/domains` → empty). Sending FROM
`@gmail.com` through SendGrid fails DMARC alignment, so mail to non-owner recipients risks
spam-foldering or rejection by strict receivers. The robust fix is to authenticate the
`mtosvelocity.com` domain in SendGrid (DNS CNAME records, owner-only) and send from e.g.
`noreply@mtosvelocity.com`. **Why:** SPF/DKIM must align with the From domain; a verified
single-sender lets you SEND but does not give DMARC alignment for an external from-domain.
