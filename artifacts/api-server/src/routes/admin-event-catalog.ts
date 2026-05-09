/**
 * Read-only event catalog + API surface descriptor for the automation
 * docs page (Task #52). Anything an admin needs to wire n8n against the
 * CRM lives in this single envelope.
 *
 * Extended (follow-up to #52): also exposes the *internal* automation node
 * catalog (the 37 nodes used by the in-CRM workflow editor) and a link
 * to the live OpenAPI spec, so n8n / Zapier / Make can discover the full
 * tool surface — not just the curated subset.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "express";
import { Permission, requirePermission } from "../lib/rbac";
import { EVENT_CATALOG } from "../lib/event-dispatcher";
import { KNOWN_SCOPES } from "../lib/api-keys";
import { NODE_CATALOG } from "../lib/automations/node-catalog";

const router = Router();

const API_SURFACE = [
  { method: "GET",   path: "/api/leads",            scope: "leads:read",  description: "List leads (paginated)." },
  { method: "GET",   path: "/api/leads/:id",        scope: "leads:read",  description: "Fetch one lead." },
  { method: "PATCH", path: "/api/leads/:id",        scope: "leads:write", description: "Update fields on a lead. Triggers lead.updated." },
  { method: "POST",  path: "/api/leads",            scope: "leads:write", description: "Create a lead. Triggers lead.created." },
  { method: "GET",   path: "/api/cases",            scope: "cases:read",  description: "List cases." },
  { method: "GET",   path: "/api/cases/:id",        scope: "cases:read",  description: "Fetch one case." },
  { method: "POST",  path: "/api/cases/:id/analyze", scope: "cases:write", description: "Enqueue case analysis (eventually emits case.stage_changed)." },
  { method: "PATCH", path: "/api/cases/:id/status",  scope: "cases:write", description: "Advance a case to a new stage (e.g. documents_received). Emits case.stage_changed on real transitions. Used by the case auto-advance n8n workflow." },
  { method: "GET",   path: "/api/paralegals",       scope: "paralegals:read",  description: "List paralegals + current load. Supports ?tort= and ?state= filters and ?sort=load_asc — used by the lead-assignment n8n workflow to route by tort + state + lowest current load." },
  { method: "GET",   path: "/api/npi/search",       scope: "npi:read",    description: "NPI lookup (CMS NPPES)." },
  { method: "GET",   path: "/api/ocr/results",      scope: "ocr:read",    description: "List OCR'd fax results." },
  { method: "POST",  path: "/api/review-queue",     scope: "review-queue:write", description: "Enqueue an item for human review." },
] as const;

// Compact projection of NODE_CATALOG — full param specs would balloon
// the response. Operators wiring n8n need to know what each internal node
// does and how many branch outputs it has so they can recreate the same
// step using HTTP Request + the published API surface.
const internalNodeCatalog = NODE_CATALOG.map((n) => ({
  type: n.type,
  label: n.label,
  category: n.category,
  description: n.description,
  inputs: n.inputs ?? 1,
  outputs: n.outputs ?? 1,
  params: n.params.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
    required: p.required ?? false,
  })),
}));

// Group node types by category so the docs page can render them as a
// table-of-contents view.
const internalNodeCategories = Array.from(
  new Set(NODE_CATALOG.map((n) => n.category)),
).map((cat) => ({
  category: cat,
  count: NODE_CATALOG.filter((n) => n.category === cat).length,
}));

// Resolve OpenAPI spec path once at module load. The repo root is two
// levels up from artifacts/api-server when running compiled, but tsx
// keeps cwd at the repo root in dev. Use process.cwd() with a fallback.
const OPENAPI_SPEC_PATH = resolve(process.cwd(), "lib/api-spec/openapi.yaml");
let openApiCache: string | null = null;
function loadOpenApiSpec(): string {
  if (openApiCache === null) {
    openApiCache = readFileSync(OPENAPI_SPEC_PATH, "utf8");
  }
  return openApiCache;
}

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
    openapi: {
      url: "/api/admin/event-catalog/openapi.yaml",
      format: "openapi-3.0",
      description: "Full OpenAPI spec for every CRM endpoint. Importable directly into n8n's HTTP Request node, Postman, Insomnia, or Stoplight.",
    },
    internal_automation: {
      description: "The 37-node catalog the in-CRM visual workflow editor uses. Anything here can also be reproduced from n8n by calling the listed API surface — every node is just a wrapper around an internal service.",
      categories: internalNodeCategories,
      nodes: internalNodeCatalog,
      editor_url: "/automations",
      catalog_url: "/api/automations/node-catalog",
    },
  });
});

// Serve the raw OpenAPI spec. Same RBAC gate as the catalog itself —
// the spec describes admin endpoints, so we don't expose it publicly.
// n8n's HTTP Request node accepts both YAML and JSON for OpenAPI import.
router.get(
  "/openapi.yaml",
  requirePermission(Permission.API_KEYS_MANAGE),
  (_req, res) => {
    try {
      const spec = loadOpenApiSpec();
      res.type("application/yaml").send(spec);
    } catch {
      res.status(500).json({ error: "OpenAPI spec not found on disk" });
    }
  },
);

export default router;
