/**
 * Read-only event catalog + API surface descriptor for the automation
 * docs page (Task #52). Anything an admin needs to wire n8n against the
 * CRM lives in this single envelope.
 */
import { Router } from "express";
import { Permission, requirePermission } from "../lib/rbac";
import { EVENT_CATALOG } from "../lib/event-dispatcher";
import { KNOWN_SCOPES } from "../lib/api-keys";

const router = Router();

const API_SURFACE = [
  { method: "GET",   path: "/api/leads",            scope: "leads:read",  description: "List leads (paginated)." },
  { method: "GET",   path: "/api/leads/:id",        scope: "leads:read",  description: "Fetch one lead." },
  { method: "PATCH", path: "/api/leads/:id",        scope: "leads:write", description: "Update fields on a lead. Triggers lead.updated." },
  { method: "POST",  path: "/api/leads",            scope: "leads:write", description: "Create a lead. Triggers lead.created." },
  { method: "GET",   path: "/api/cases",            scope: "cases:read",  description: "List cases." },
  { method: "GET",   path: "/api/cases/:id",        scope: "cases:read",  description: "Fetch one case." },
  { method: "POST",  path: "/api/cases/:id/analyze", scope: "cases:write", description: "Enqueue case analysis (eventually emits case.stage_changed)." },
  { method: "GET",   path: "/api/paralegals",       scope: "paralegals:read",  description: "List paralegals + current load (used for round-robin)." },
  { method: "GET",   path: "/api/npi/search",       scope: "npi:read",    description: "NPI lookup (CMS NPPES)." },
  { method: "GET",   path: "/api/ocr/results",      scope: "ocr:read",    description: "List OCR'd fax results." },
  { method: "POST",  path: "/api/review-queue",     scope: "review-queue:write", description: "Enqueue an item for human review." },
] as const;

router.get("/", requirePermission(Permission.API_KEYS_MANAGE), (_req, res) => {
  res.json({
    events: EVENT_CATALOG,
    api_surface: API_SURFACE,
    available_scopes: KNOWN_SCOPES,
    auth: {
      header: "Authorization: Bearer <token>",
      token_types: [
        { type: "jwt", description: "User session token from /auth/login. 15-minute expiry." },
        { type: "api_key", description: "Long-lived service-account token (mtos_…). Scoped per-resource. No expiry until revoked." },
      ],
      api_key_admin_url: "/api/admin/api-keys",
    },
    webhook_signing: {
      header: "X-MTOS-Signature: sha256=<hex>",
      algorithm: "HMAC-SHA256",
      secret_source: "integrations.config.credentials.api_key (set via Integrations admin page)",
      headers: ["X-MTOS-Event", "X-MTOS-Delivery", "X-MTOS-Signature", "X-MTOS-Test"],
    },
  });
});

export default router;
