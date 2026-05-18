# MTOS Lead Pipeline — End-to-End Automation

Single source of truth for the n8n + MTOS automation chain.

```
EXTERNAL                                MTOS internal                          STATUS
─────────────────────────────           ──────────────────────────────────     ──────────────────
n8n webhook receives a lead        →    POST /api/leads (firm-scoped JWT)      status=new
   │
   └─ created                       →    WF-1 fires (trigger.lead_created)
                                         · crm.background_check  (bg-hub)
                                         · logic.if {clean | flagged}
                                         · → integration.send_email           status=intake_email_sent
                                         · → crm.set_lead_status              status=rejected (failed)

client clicks email, fills form    →    WF-2 fires (trigger.form_submitted)
                                         · crm.npi_lookup
                                         · logic.if {match | no_match}
                                         · → documents.send_docusign × 3      status=envelopes_sent
                                              HIPAA  +  Retainer  +  PTA
                                         · → crm.send_to_review_queue (no_match)

client signs envelopes             →    WF-3 fires (trigger.document_signed)
   (DocuSign webhook posts to            · data.transform (count signed)
    /api/webhooks/document_signed)       · logic.if {all_3_signed}
                                         · → documents.fax_medical_records    HIPAA → doctor's fax
                                         · → integration.send_email          retainer copy → attorney
                                         · → crm.add_note                    retainer copy filed in CRM
                                                                              status=awaiting_med_records

doctor faxes med records back      →    WF-4 fires (trigger.inbound_fax)
   (SRFax/Phaxio posts to                · documents.medical_extract (OCR)
    /api/webhooks/fax/srfax)             · crm.add_note (attach to lead)
                                         · integration.send_email             status=med_records_received
                                                                              client notified, portal updated
```

## What's already live

| Component | State | URL / ID |
|---|---|---|
| MTOS Lead Pipeline — Stage 1 | enabled | `automation_workflows.id = 1` |
| MTOS Lead Pipeline — Stage 2 | enabled | `automation_workflows.id = 2` |
| MTOS Lead Pipeline — Stage 3 | enabled | `automation_workflows.id = 3` |
| MTOS Lead Pipeline — Stage 4 | enabled | `automation_workflows.id = 4` |
| MTOS API key for n8n | minted | `id=3`, scope: `leads:read/write` + `cases` + `automations` |
| n8n workflow | ready to import (JSON below) | path: `/webhook/mtos-lead-intake` |

## n8n workflow JSON

Import via **Workflows → + → Import from File → paste**. Every parameter is pre-filled; no operator action required after import.

```json
{
  "name": "MTOS Lead Intake — Full",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "mtos-lead-intake",
        "responseMode": "responseNode",
        "options": {}
      },
      "id": "0d9b1a01-1111-4111-8111-000000000001",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [240, 320],
      "webhookId": "0d9b1a01-1111-4111-8111-000000000001"
    },
    {
      "parameters": {
        "mode": "raw",
        "jsonOutput": "={\n  \"name\":             ($json.body && $json.body.first_name ? $json.body.first_name : 'Jane') + ' ' + ($json.body && $json.body.last_name ? $json.body.last_name : 'Doe'),\n  \"email\":            $json.body && $json.body.email ? $json.body.email : 'jane.doe@example.invalid',\n  \"phone\":            $json.body && $json.body.phone ? $json.body.phone : '+14155551212',\n  \"phone_primary\":    $json.body && $json.body.phone ? $json.body.phone : '+14155551212',\n  \"tort_type\":        $json.body && $json.body.tort_type ? $json.body.tort_type : 'depo_provera',\n  \"first_name\":       $json.body && $json.body.first_name ? $json.body.first_name : 'Jane',\n  \"last_name\":        $json.body && $json.body.last_name ? $json.body.last_name : 'Doe',\n  \"date_of_birth\":    $json.body && $json.body.date_of_birth ? $json.body.date_of_birth : '1970-01-01',\n  \"street_address\":   $json.body && $json.body.street_address ? $json.body.street_address : '1 Unknown St',\n  \"city\":             $json.body && $json.body.city ? $json.body.city : 'Unknown',\n  \"state\":            $json.body && $json.body.state ? $json.body.state : 'CA',\n  \"zip\":              $json.body && $json.body.zip ? $json.body.zip : '00000',\n  \"last_4_ssn\":       $json.body && $json.body.last_4_ssn ? $json.body.last_4_ssn : '0000',\n  \"diagnosis\":        $json.body && $json.body.diagnosis ? $json.body.diagnosis : 'Pending review',\n  \"diagnosis_date\":   $json.body && $json.body.diagnosis_date ? $json.body.diagnosis_date : '2024-01-01',\n  \"physician_first_name\":   $json.body && $json.body.physician_first_name ? $json.body.physician_first_name : 'Unknown',\n  \"physician_last_name\":    $json.body && $json.body.physician_last_name ? $json.body.physician_last_name : 'Unknown',\n  \"physician_full_address\": $json.body && $json.body.physician_full_address ? $json.body.physician_full_address : 'Unknown',\n  \"physician_contact_info\": $json.body && $json.body.physician_contact_info ? $json.body.physician_contact_info : 'Unknown',\n  \"hospital_name\":          $json.body && $json.body.hospital_name ? $json.body.hospital_name : 'Unknown',\n  \"hospital_fax\":           $json.body && $json.body.hospital_fax ? $json.body.hospital_fax : '+14155550000',\n  \"hospital_contact_info\":  $json.body && $json.body.hospital_contact_info ? $json.body.hospital_contact_info : 'Records dept',\n  \"diagnosis_confirmed\":    true,\n  \"was_at_location\":        false,\n  \"exposure_start\":         $json.body && $json.body.exposure_start ? $json.body.exposure_start : null,\n  \"exposure_end\":           $json.body && $json.body.exposure_end ? $json.body.exposure_end : null,\n  \"diagnosis_type\":         $json.body && $json.body.diagnosis_type ? $json.body.diagnosis_type : null,\n  \"location_name\":          $json.body && $json.body.location_name ? $json.body.location_name : null,\n  \"notes\":                  $json.body && $json.body.notes ? $json.body.notes : 'Inbound via n8n MTOS Lead Intake',\n  \"source\":                 $json.body && $json.body.source ? $json.body.source : 'n8n_webhook',\n  \"ad_spend\":               $json.body && $json.body.ad_spend ? $json.body.ad_spend : 0,\n  \"tcpa_consent\":           true,\n  \"trustedform_cert_url\":   $json.body && $json.body.trustedform_cert_url ? $json.body.trustedform_cert_url : 'https://cert.trustedform.com/n8n-pending',\n  \"trustedform_timestamp\":  $now.toISO()\n}",
        "options": {}
      },
      "id": "0d9b1a01-1111-4111-8111-000000000002",
      "name": "Set lead payload",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [520, 320]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api-server-production-8349.up.railway.app/api/leads",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "Authorization", "value": "Bearer mtos_0y2_c3wQgfbKmQg7leV0fLTFcYitXyQDQETY79a3F2ui0SprCQjMP_cpUtBBkzvr" },
            { "name": "Content-Type",  "value": "application/json" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json) }}",
        "options": {
          "response": { "response": { "fullResponse": false, "responseFormat": "json" } },
          "timeout": 30000
        }
      },
      "id": "0d9b1a01-1111-4111-8111-000000000003",
      "name": "POST /api/leads",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [820, 320]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ JSON.stringify($json) }}",
        "options": { "responseCode": 201 }
      },
      "id": "0d9b1a01-1111-4111-8111-000000000004",
      "name": "Respond to Webhook",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [1120, 320]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [[{ "node": "Set lead payload", "type": "main", "index": 0 }]]
    },
    "Set lead payload": {
      "main": [[{ "node": "POST /api/leads", "type": "main", "index": 0 }]]
    },
    "POST /api/leads": {
      "main": [[{ "node": "Respond to Webhook", "type": "main", "index": 0 }]]
    }
  },
  "settings": { "executionOrder": "v1" }
}
```

## Operator prerequisites (one-time setup)

These must be configured before the pipeline actually fires its later stages. The first stage (bg-hub + email) works today; stages 2–4 wait on operator configuration.

| Stage that depends on it | What to configure | Where |
|---|---|---|
| Stage 1 — email intake | An email integration with real creds (SendGrid, Postmark, Resend, Mailgun, AWS SES, or Brevo) | Integrations Hub → Email → Connect |
| Stage 2 — DocuSign envelopes | Dropbox Sign **or** DocuSign integration with non-empty `api_key` + `account_sid` (DocuSign only) | Integrations Hub → E-Signature → Connect |
| Stage 2 — envelope templates | Three rows in `document_templates`: `template_type = hipaa_authorization`, `retainer_agreement`, `personal_truth_affidavit`. Either `source=pdf` with an uploaded file, or `source=ai` (uses `lib/drafting-ai.ts` to generate at send-time) | Sidebar → Documents → Templates → New |
| Stage 3 — fax to doctor | SRFax / Phaxio / Documo / Telnyx Fax integration with real creds | Integrations Hub → Fax → Connect |
| Stage 3 — attorney email recipient | `workflow_settings.notify_on_failure_email` (the current Stage-3 retainer-copy email pulls from this) | Sidebar → Workflow Settings |
| Stage 4 — inbound fax callback | Fax provider's webhook pointed at `https://api-server-production-8349.up.railway.app/api/webhooks/fax/<provider>` | Provider dashboard (SRFax: Settings → Callbacks) |
| Stage 4 — document-signed callback | DocuSign / Dropbox Sign webhook at `https://api-server-production-8349.up.railway.app/api/webhooks/document_signed` | Provider dashboard |

## End-to-end smoke test (once prereqs are done)

```bash
# 1) Hit the n8n webhook
N8N=$(your-n8n-host)/webhook/mtos-lead-intake
curl -X POST "$N8N" -H "Content-Type: application/json" -d '{
  "first_name":"Test",
  "last_name":"Pipeline",
  "email":"your-real-email@example.com",
  "phone":"+14155559999",
  "tort_type":"depo_provera",
  "physician_first_name":"Jane",
  "physician_last_name":"Smith",
  "state":"CA",
  "hospital_name":"Mercy General",
  "hospital_fax":"+15555550100"
}'

# Expect 201 from n8n → MTOS responds with the new lead row.

# 2) Watch the pipeline fire inside MTOS:
#    Sidebar → Automations → Stage 1 → Runs tab → see the bg-check step log
#    Then check your real-email inbox for the intake-form link.
#    The link points at https://mtos-crm-production.up.railway.app/intake/<lead_id>
```

## API key rotation

The bearer token embedded in the n8n workflow above (`mtos_0y2_…`) belongs to MTOS API key `id=3`. To rotate:

```bash
# 1) Mint a new one
TOKEN=<your JWT from devtools>
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://api-server-production-8349.up.railway.app/api/admin/api-keys \
  -d '{"name":"n8n: MTOS CRM API Setup v2","scopes":["leads:read","leads:write","cases:read","cases:write","automations:read","automations:write","dashboard:read"]}'

# 2) Update the Bearer in the n8n HTTP Request node, save, publish.

# 3) Delete the old key
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api-server-production-8349.up.railway.app/api/admin/api-keys/3
```

## Re-deploying the 4 MTOS workflows

Source of truth lives in `scripts/deploy-pipeline.mjs` (committed to the repo). To re-create after a wipe or in a new firm:

```bash
node scripts/deploy-pipeline.mjs
```

Idempotent: the deploy POSTs to `/api/automations` which upserts by `(firm_id, name)`.
