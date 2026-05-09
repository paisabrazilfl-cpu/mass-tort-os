/**
 * Form API Directory — operator-facing index of every published intake
 * form and the public submit endpoint that backs it.
 *
 * Why this exists: the per-form public submit URL has been live for a
 * long time (`POST /api/forms-public/submit/:formId`) but operators
 * have had no way to discover what the URL is for a given tort, what
 * JSON shape to POST, or how to call it from n8n / Zapier / a vendor
 * site without reverse-engineering the form-builder. This endpoint is
 * the single source of truth so a downstream UI page can render
 * "here is your form's public API" cards without knowing internals.
 *
 * Mounted at /api/admin/forms-api-directory. Gated by FORMS_CONFIG_VIEW
 * which every operator who can see the form-engine already holds.
 *
 * The submit URL is returned as a relative path; the consumer is
 * responsible for prepending the public origin (the React page reads
 * window.location.origin). We deliberately do NOT bake the host in
 * server-side because the same response is valid for the dev preview
 * domain, the production .replit.app domain, and any custom domain.
 */
import { Router } from "express";
import { Permission, requirePermission } from "../lib/rbac";
import { getAllFormConfigs } from "../lib/form-config-service";

const router = Router();

/**
 * Map a form_configurations row to the JSON-schema-ish shape an
 * operator needs to call the form's public submit endpoint. The output
 * is intentionally compact and human-readable rather than a real JSON
 * Schema document — the goal is "I can write this curl in 30 seconds",
 * not "feed this into ajv".
 */
function buildFieldDescriptors(form: Awaited<ReturnType<typeof getAllFormConfigs>>[number]) {
  type FieldDescriptor = {
    key: string;
    label: string;
    type: string;
    required: boolean;
    section?: string;
    helper_text?: string;
    options?: string[];
    source: "web_form" | "custom" | "legacy_extra" | "legacy_exposure";
  };

  const out: FieldDescriptor[] = [];

  // Web-form fields are the canonical public-intake shape — these are
  // the ones the public submit endpoint actually validates against
  // when the form is wired through the new web-forms surface.
  const webFields = form.web_form_config?.fields ?? [];
  for (const f of webFields) {
    out.push({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      section: f.section,
      helper_text: f.helper_text,
      options: f.options,
      source: "web_form",
    });
  }

  // Operator-defined custom fields (the legacy intake path). Surfaced
  // alongside web fields because some forms use both.
  for (const f of form.custom_fields ?? []) {
    if (out.some((x) => x.key === f.key)) continue;
    out.push({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      helper_text: f.helper_text,
      options: f.options,
      source: "custom",
    });
  }

  // Built-in legacy fields surfaced as bare keys. These are not strict
  // requirements at the public endpoint but operators need to know
  // they exist so n8n payloads can match how the operator-built
  // intake forms are structured.
  for (const k of form.exposure_fields ?? []) {
    if (out.some((x) => x.key === k)) continue;
    out.push({
      key: k,
      label: k,
      type: "text",
      required: !!form.required_exposure,
      source: "legacy_exposure",
    });
  }
  for (const k of form.extra_fields ?? []) {
    if (out.some((x) => x.key === k)) continue;
    out.push({
      key: k,
      label: k,
      type: "text",
      required: false,
      source: "legacy_extra",
    });
  }

  return out;
}

/**
 * Build a minimal POST payload an operator can copy into a curl call
 * to verify the form responds. Only includes the standard contact
 * triplet plus the form's required fields — keeps the example short
 * enough to read at a glance while still passing baseline validation.
 */
function buildSamplePayload(fields: ReturnType<typeof buildFieldDescriptors>) {
  const sample: Record<string, unknown> = {
    first_name: "Test",
    last_name: "Lead",
    email: "test@example.com",
    phone: "+15555550100",
    state: "CA",
    consent_tcpa: true,
  };
  for (const f of fields) {
    if (!f.required) continue;
    if (f.key in sample) continue;
    switch (f.type) {
      case "email": sample[f.key] = "test@example.com"; break;
      case "tel":   sample[f.key] = "+15555550100"; break;
      case "date":  sample[f.key] = "2024-01-01"; break;
      case "number": sample[f.key] = 0; break;
      case "checkbox": sample[f.key] = true; break;
      case "select":
      case "radio":
      case "state":
        sample[f.key] = f.options?.[0] ?? "value";
        break;
      default: sample[f.key] = "example";
    }
  }
  return sample;
}

router.get(
  "/",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (_req, res) => {
    const forms = await getAllFormConfigs();
    const directory = forms.map((form) => {
      const fields = buildFieldDescriptors(form);
      // Public submit URL is path-relative; the React caller prepends
      // window.location.origin so the same response is correct on the
      // preview domain, .replit.app, and any custom domain.
      const submitPath = `/api/forms-public/submit/${form.id}`;
      return {
        id: form.id,
        label: form.label,
        category: form.category,
        active: form.active,
        web_form_enabled: form.web_form_config?.enabled ?? false,
        intro_text: form.intro_text,
        submit_path: submitPath,
        method: "POST" as const,
        content_type: "application/json",
        // Public submit accepts anonymous calls today (rate-limited
        // per IP). Surface that explicitly so operators know they
        // do NOT need to attach a key — and so the page can show a
        // banner if/when we later require keyed access.
        auth: "anonymous_rate_limited" as const,
        fields,
        sample_payload: buildSamplePayload(fields),
        // Concrete curl example — one less thing for the operator
        // to assemble. Host is a placeholder the React page swaps
        // for window.location.origin at render time.
        curl_example: [
          `curl -X POST "{ORIGIN}${submitPath}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '${JSON.stringify(buildSamplePayload(fields))}'`,
        ].join("\n"),
      };
    });

    res.json({
      base_path: "/api/forms-public/submit",
      total: directory.length,
      active: directory.filter((d) => d.active).length,
      forms: directory,
    });
  },
);

export default router;
