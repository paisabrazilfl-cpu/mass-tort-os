// Integration coverage for the render-time consent canonicalization
// (Task: lock in the new consent so it can never silently revert on existing
// forms).
//
// The expanded claimant consent is NOT migrated into stored configs — it is
// forced onto the field list at RENDER time via `withCanonicalConsent`. So a
// form whose stored `form_configurations.web_form_config` still carries the OLD
// short consent label must STILL serve the current canonical block on every
// public render surface. If a future change drops the canonicalization on any
// one of these paths, legacy forms would silently serve stale/incorrect consent
// — a legal-text correctness risk.
//
// This suite seeds exactly that hazard (a stored config with the OLD label) and
// asserts the canonical text appears, and the old label does NOT, across all
// three render surfaces:
//   (1) GET /api/web-forms/:tortId          — the JSON config the embed consumes
//   (2) GET /api/web-forms/:tortId/embed.js — the generated embed bundle
//   (3) renderDraftIntakePreviewHtml(...)   — the SSR draft preview
//
// We boot the real Express app on an ephemeral port so the public routes run
// end-to-end, and we read the seeded row back through getFormConfig() for the
// SSR surface (the same loader the live /intake page uses).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { formConfigurationsTable } from "@workspace/db";
import type { WebFormConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CLAIMANT_CONSENT_ACKNOWLEDGMENT, CONSENT_FIELD_KEY } from "../../lib/consent-copy.js";
import { renderDraftIntakePreviewHtml } from "../../lib/site-render.js";
import { getFormConfig } from "../../lib/form-config-service.js";

// These public render routes carry no permission/billing gate; disable audit +
// any defensively-mounted billing gate so the suite boots cleanly.
process.env["RBAC_DISABLE_AUDIT"] = "1";
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

// A custom tort id NOT present in TORT_REGISTRY, so the seeder never touches /
// refreshes our row — it stays exactly as we wrote it (old label preserved).
const TORT_ID = `consent-legacy-${Date.now()}`;
const TORT_LABEL = "Legacy Consent Test Tort";

// The OLD short consent label, as a pre-expansion stored config would carry it.
const OLD_CONSENT_LABEL = "I agree to be contacted about my claim.";

// A distinctive substring of the canonical block that is free of characters
// that get HTML-escaped (', ", &, <, >) so it appears verbatim in the JSON
// surface, the JSON-embedded embed bundle, AND the html-escaped SSR preview.
const CANONICAL_PROBE = "knowingly, voluntarily, and affirmatively agree and attest";

const LEGACY_WEB_FORM_CONFIG: WebFormConfig = {
  enabled: true,
  intro_headline: "Tell us about your claim",
  intro_subhead: "A few quick questions.",
  fields: [
    {
      key: "full_name",
      label: "Full name",
      type: "text",
      section: "contact",
      required: true,
    },
    {
      // Stored with the OLD label + wrong type/required, exactly the drift the
      // canonicalization must paper over at render time.
      key: CONSENT_FIELD_KEY,
      label: OLD_CONSENT_LABEL,
      type: "text",
      section: "contact",
      required: false,
    },
  ],
  eligibility_rules: [],
  send_confirmation_email: false,
  confirmation_subject: "",
  confirmation_body_html: "",
};

before(async () => {
  // Seed the legacy form. updated_by is set non-null so the seeder treats it as
  // hand-edited and never refreshes registry-managed fields onto it.
  await db
    .insert(formConfigurationsTable)
    .values({
      id: TORT_ID,
      label: TORT_LABEL,
      category: "test",
      active: true,
      updated_by: 1,
      web_form_config: LEGACY_WEB_FORM_CONFIG,
    })
    .onConflictDoNothing();

  const appMod = (await import("../../app.js")) as { default: Express };
  const app = appMod.default;
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        reject(new Error("could not resolve listen address"));
        return;
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      close = () =>
        new Promise<void>((res) => {
          closeAllConnections(server);
          server.close(() => res());
        });
      resolve();
    });
    server.on("error", reject);
  });
});

after(async () => {
  await db
    .delete(formConfigurationsTable)
    .where(eq(formConfigurationsTable.id, TORT_ID))
    .catch(() => {});
  await close();
});

test("sanity: the stored config still carries the OLD consent label (no migration)", async () => {
  const cfg = await getFormConfig(TORT_ID);
  assert.ok(cfg, "seeded form config must load");
  const stored = cfg.web_form_config?.fields.find((f) => f.key === CONSENT_FIELD_KEY);
  assert.ok(stored, "stored config must have a tcpa_consent field");
  assert.equal(
    stored.label,
    OLD_CONSENT_LABEL,
    "this test only proves render-time fixing if the STORED label is still the old one",
  );
});

test("(1) GET /api/web-forms/:tortId serves the canonical consent, not the stored old label", async () => {
  const res = await fetch(`${baseUrl}/api/web-forms/${TORT_ID}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { fields: Array<{ key: string; label: string; type: string; required: boolean }> };
  const consent = body.fields.find((f) => f.key === CONSENT_FIELD_KEY);
  assert.ok(consent, "public config must include the consent field");
  assert.equal(
    consent.label,
    CLAIMANT_CONSENT_ACKNOWLEDGMENT,
    "consent label must be the canonical block, not the stored old label",
  );
  assert.equal(consent.type, "checkbox");
  assert.equal(consent.required, true);
  assert.notEqual(consent.label, OLD_CONSENT_LABEL, "the old label must not leak through");
});

test("(2) GET /api/web-forms/:tortId/embed.js embeds the canonical consent text", async () => {
  const res = await fetch(`${baseUrl}/api/web-forms/${TORT_ID}/embed.js`);
  assert.equal(res.status, 200);
  const js = await res.text();
  assert.ok(
    js.includes(CANONICAL_PROBE),
    "embed bundle must contain the canonical consent block",
  );
  assert.ok(
    !js.includes(OLD_CONSENT_LABEL),
    "embed bundle must not contain the stored old consent label",
  );
});

test("(3) SSR draft preview renders the canonical consent text", async () => {
  const cfg = await getFormConfig(TORT_ID);
  assert.ok(cfg?.web_form_config, "seeded config must load for SSR preview");
  const html = renderDraftIntakePreviewHtml(cfg.web_form_config, cfg.label);
  assert.ok(
    html.includes(CANONICAL_PROBE),
    "SSR draft preview must render the canonical consent block",
  );
  assert.ok(
    !html.includes(OLD_CONSENT_LABEL),
    "SSR draft preview must not render the stored old consent label",
  );
});
