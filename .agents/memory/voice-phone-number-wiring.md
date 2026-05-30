---
name: Voice phone-number wiring (outbound vs inbound)
description: How Vapi phone numbers attach to the 31 per-tort voice agents — one shared number covers all outbound; dedicated numbers are inbound-only.
---

# Phone numbers: outbound is shared, inbound is per-tort

The per-tort voice agents do NOT each need their own phone number.

**Outbound** dialing uses a SINGLE shared caller-ID: the voice integration's
`config.userConfig.phone_number_id` (a Vapi phone-number resource id). The Vapi
adapter reads it as `creds.config.phone_number_id` and passes `phoneNumberId` to
`POST /call`. The assistant is chosen per-call, so ONE number lets all 31 agents
place outbound calls. If `phone_number_id` is unset, outbound has no caller ID.

**Inbound** dedicated routing is the only thing that needs a number PER tort:
rows in `tort_phone_numbers` map a dialed E.164 (and optional
`vapi_phone_number_id`) to a `tort_id`, and best-effort PATCH the Vapi number to
that tort's active assistant. One number can dedicate to only one tort.

**Why:** buying one number per agent is wasted money — outbound never needs it.
Only buy additional numbers when a tort needs its own inbound line for caller
attribution.

**Vapi free-number cap = 10 per account.** Creating an 11th free number
(`provider:"vapi"`) returns HTTP 400 "You have reached the maximum number of
free phone numbers." Beyond 10, numbers must be imported from a paid carrier
(Telnyx/Twilio BYO + a SIP connection), which is a separate recurring spend.
Vapi free-number creation also REQUIRES `numberDesiredAreaCode` (or `sipUri`) —
omitting it returns a 400. When >10 dedicated numbers are wanted, reallocate the
10 free ones to the highest-priority torts (PATCH `/phone-number/:id`
{assistantId} + move the tort_phone_numbers row) rather than buying more.

**How to apply:**
- To "attach a phone number so agents can call out", set
  `phone_number_id` on the active voice integration's `userConfig` (merge with
  jsonb, preserve the encrypted `credentials` key). Resolved integration =
  `resolveProvider("voice")` (multiple active → most recent).
- Vapi free numbers have `provider:"vapi"` and are limited per account.
- Prod (Render) DB is separate — set prod's caller-ID via the production app's
  integration/dialer settings, not from this dev environment.
