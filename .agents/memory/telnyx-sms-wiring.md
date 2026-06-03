---
name: Telnyx SMS wiring (vault provider swap)
description: How to wire Telnyx as the live SMS provider in MTOS, plus the Telnyx API gotchas that 422/400 the setup.
---

# Wiring a vault SMS provider (Telnyx) live

SMS adapters read credentials from the **integration vault** (`getIntegrationCredentialsById`), never from env. An env var like `TELNYX_API_KEY` is only a **secure handoff**: request it via the secret box, then in a temp script encrypt it into the vault row and (optionally) leave the env var inert.

**Two things make a provider go live:**
1. **Vault row** — `integrations` row with `provider` = the adapter key (`"telnyx"`), `type="sms"`, `status="active"`. Secrets go in `config.credentials` **encrypted** with `encrypt(value, "integration:<field>", String(rowId))` (id-scoped AAD — do the two-step insert to get the id first). Non-secret operator config (`from_number`, `messaging_profile_id`) goes in `config.userConfig`.
2. **Provider selection** — flip the global `workflow_settings` (scope=`"global"`) FK for the category: `sms_provider_integration_id` → the new row id. `resolveProvider("sms")` reads this; null FK falls back to `DEFAULT_PROVIDER_BY_CATEGORY` (sms→telnyx). To switch back to Twilio, just point the FK at the Twilio row again — both rows can coexist.

## Telnyx API gotchas (each one blocked setup)
- **Messaging profile create requires `whitelisted_destinations`** (e.g. `["US"]`) or it 400s with `40331 Missing whitelisted destinations`.
- **Attach a number to a profile via `PATCH /v2/phone_numbers/{id}/messaging`** with `{messaging_profile_id}` — the base `PATCH /v2/phone_numbers/{id}` 422s (it only handles tags/connection, not messaging).
- **The `from` number MUST belong to the sending messaging profile**, else send 400s: *"The 'from' address should be string containing a valid number associated with the sending messaging profile."* Adapter needs `from_number` OR `messaging_profile_id` in config; it prefers `from`.
- Send endpoint: `POST /v2/messages` Bearer key, `{to, text, from, messaging_profile_id}`. Success = `data.id`. Delivery status: `GET /v2/messages/{id}` → `data.to[].status`.

## US carrier delivery reality
Number-to-number test between two owned Telnyx numbers **delivered** with no 10DLC registration. But **local (long-code) numbers still need 10DLC brand+campaign registration** for reliable delivery to real subscriber carriers at volume — same compliance gate as Twilio toll-free verification. Don't promise clean production delivery on unregistered local numbers.
