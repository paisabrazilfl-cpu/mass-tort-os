// Coverage for provisionTortAgent — the idempotent create/update state
// machine that keeps one Vapi assistant in sync per tort (Task #90/#92).
//
// The provisioning service is the only thing standing between an operator
// clicking "Provision" and a real assistant existing upstream, so its
// branch table is exactly what we pin here:
//
//   (1) create        — no row yet → POST /assistant → row goes active
//                        with a non-null fingerprint and assistant id.
//   (2) in_sync        — second run with an unchanged fingerprint must NOT
//                        touch the Vapi API at all (fast path). We prove
//                        "no call" by arming the mock to reject every
//                        request; if a fetch leaks, the outcome flips to
//                        error and the assertion fails loudly.
//   (3) drift → update — a changed stored fingerprint forces a PATCH to
//                        the existing assistant id.
//   (4) 404 → recreate — when the upstream assistant has vanished, the
//                        PATCH 404s and the service falls back to POST,
//                        adopting the new assistant id (outcome=created).
//   (5) no API base    — without PUBLIC_API_BASE the tool callbacks can't
//                        be wired, so the service refuses to provision a
//                        tools-less assistant and writes status=error.
//   (6) missing key    — when the resolved Vapi integration has no api_key
//                        the service surfaces a structured error and never
//                        calls Vapi.
//
// We follow the repo's integration-test pattern (see fasten-job.test.ts):
// seed a REAL vapi integration row with AAD-bound encrypted credentials,
// pin it as the global voice provider for the duration of the suite, and
// script the Vapi management API via globalThis.fetch. Everything else —
// provider resolution, fingerprinting, db upsert — runs as it would in
// production.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  integrationsTable,
  workflowSettingsTable,
  tortVoiceAgentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { encrypt } from "../encryption.js";
import { TORT_REGISTRY } from "../tort-engine.js";
import { provisionTortAgent } from "../voice/tort-agent-provisioning.js";

const VAPI_BASE = "https://api.vapi.ai";
const TS = Date.now();

// A real tort from the registry — provisioning only operates on known
// torts, so we borrow the first registered id for the whole suite.
const TEST_TORT = Object.keys(TORT_REGISTRY)[0]!;

// Scripted Vapi management API behavior. beforeEach resets this so each
// test controls its own create/patch outcome without re-seeding the rest
// of the fixture.
interface FetchScript {
  // assistant id returned by POST /assistant.
  postId: string;
  // HTTP status PATCH /assistant/:id returns (200 = ok, 404 = vanished).
  patchStatus: number;
  // When true, ANY network call is a test failure (used to prove the
  // in_sync fast path never touches Vapi).
  rejectAll: boolean;
}

const script: FetchScript = { postId: "asst_default", patchStatus: 200, rejectAll: false };

function mockFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : (input as URL | Request).toString();
  const method = (init?.method ?? "GET").toUpperCase();

  if (script.rejectAll) {
    return Promise.reject(new Error(`Unexpected Vapi call in in_sync fast path: ${method} ${url}`));
  }

  // POST /assistant — create a new assistant.
  if (url === `${VAPI_BASE}/assistant` && method === "POST") {
    return Promise.resolve(
      new Response(JSON.stringify({ id: script.postId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  // PATCH /assistant/:id — update an existing assistant.
  const patchMatch = url.match(/\/assistant\/([^/?]+)$/);
  if (patchMatch && method === "PATCH") {
    if (script.patchStatus === 404) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "assistant not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: patchMatch[1] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  return Promise.reject(new Error(`Unscripted fetch in tort-agent-provisioning test: ${method} ${url}`));
}

let integrationId = 0;
let originalVoiceFk: number | null = null;
let originalFetch: typeof globalThis.fetch;
let originalApiBase: string | undefined;
let originalReplitDomains: string | undefined;
// Snapshot of any pre-existing agent row for TEST_TORT so a shared dev DB
// that already provisioned this tort is restored byte-for-byte after the
// suite — we borrow a real registry tort id, so we must not destroy real
// state.
let originalAgentRow: typeof tortVoiceAgentsTable.$inferSelect | null = null;

before(async () => {
  // Stable public API base so fingerprints are deterministic across runs
  // and the tool callbacks have a wiring target.
  originalApiBase = process.env["PUBLIC_API_BASE"];
  originalReplitDomains = process.env["REPLIT_DOMAINS"];
  process.env["PUBLIC_API_BASE"] = "https://tort-agent-test.invalid";

  // Seed a vapi integration the same way the real route does: insert
  // pending (so credential reads return null until creds land), then
  // attach AAD-bound encrypted credentials and flip to active.
  const [integration] = await db
    .insert(integrationsTable)
    .values({
      name: `Vapi (provisioning test ${TS})`,
      type: "voice",
      provider: "vapi",
      status: "pending",
    } as typeof integrationsTable.$inferInsert)
    .returning({ id: integrationsTable.id });
  integrationId = integration!.id;

  const credentials = {
    api_key: encrypt("vapi_test_key", "integration:api_key", String(integrationId)),
    client_secret: encrypt("vapi_test_bearer", "integration:client_secret", String(integrationId)),
  };
  await db
    .update(integrationsTable)
    .set({ status: "active", config: { credentials } })
    .where(eq(integrationsTable.id, integrationId));

  // Pin our seeded integration as the global voice provider so
  // resolveProvider("voice") is deterministic regardless of what else
  // exists in the shared dev database. Remember the original FK to
  // restore it after the suite.
  const [settings] = await db
    .select({ fk: workflowSettingsTable.voice_provider_integration_id })
    .from(workflowSettingsTable)
    .where(eq(workflowSettingsTable.scope, "global"));
  originalVoiceFk = settings?.fk ?? null;
  await db
    .update(workflowSettingsTable)
    .set({ voice_provider_integration_id: integrationId })
    .where(eq(workflowSettingsTable.scope, "global"));

  // Snapshot any pre-existing agent row so we can restore it verbatim —
  // beforeEach/the tests overwrite this real tort's row.
  const [existingRow] = await db
    .select()
    .from(tortVoiceAgentsTable)
    .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
  originalAgentRow = existingRow ?? null;

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;

  if (originalApiBase === undefined) delete process.env["PUBLIC_API_BASE"];
  else process.env["PUBLIC_API_BASE"] = originalApiBase;
  if (originalReplitDomains === undefined) delete process.env["REPLIT_DOMAINS"];
  else process.env["REPLIT_DOMAINS"] = originalReplitDomains;

  // Restore shared global state loudly — a silent failure here would leave
  // the global voice provider pinned at the test integration (or this
  // tort's row destroyed) for every other suite on the shared dev DB.
  //
  // Order matters: re-point the global FK to the original integration
  // BEFORE deleting ours, so settings never reference a deleted row.
  await db
    .update(workflowSettingsTable)
    .set({ voice_provider_integration_id: originalVoiceFk })
    .where(eq(workflowSettingsTable.scope, "global"));

  await db.delete(integrationsTable).where(eq(integrationsTable.id, integrationId));

  // Restore the tort's agent row to exactly what we found (or remove the
  // row entirely if the tort had none before this suite ran).
  await db.delete(tortVoiceAgentsTable).where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
  if (originalAgentRow) {
    await db.insert(tortVoiceAgentsTable).values(originalAgentRow);
  }
});

beforeEach(async () => {
  // Fresh slate per test: no stored agent row, default scripted outcomes.
  script.postId = "asst_default";
  script.patchStatus = 200;
  script.rejectAll = false;
  process.env["PUBLIC_API_BASE"] = "https://tort-agent-test.invalid";
  await db.delete(tortVoiceAgentsTable).where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
});

test("creates a new assistant when the tort has none", async () => {
  script.postId = "asst_created";
  const res = await provisionTortAgent(TEST_TORT);

  assert.equal(res.outcome, "created");
  assert.equal(res.vapi_assistant_id, "asst_created");
  assert.equal(res.error, null);

  const [row] = await db
    .select()
    .from(tortVoiceAgentsTable)
    .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
  assert.equal(row?.status, "active");
  assert.equal(row?.vapi_assistant_id, "asst_created");
  assert.ok(row?.prompt_fingerprint, "fingerprint should be persisted on create");
  assert.equal(row?.last_error, null);
});

test("is in_sync (no Vapi call) on an unchanged second run", async () => {
  script.postId = "asst_sync";
  const first = await provisionTortAgent(TEST_TORT);
  assert.equal(first.outcome, "created");

  // Arm the mock to reject any call — the fast path must not hit Vapi.
  script.rejectAll = true;
  const second = await provisionTortAgent(TEST_TORT);

  assert.equal(second.outcome, "in_sync");
  assert.equal(second.vapi_assistant_id, "asst_sync");
  assert.equal(second.error, null);
});

test("updates the existing assistant when the fingerprint drifts", async () => {
  script.postId = "asst_drift";
  const first = await provisionTortAgent(TEST_TORT);
  assert.equal(first.outcome, "created");

  // Simulate drift: stored fingerprint no longer matches the generated one.
  await db
    .update(tortVoiceAgentsTable)
    .set({ prompt_fingerprint: "stale-fingerprint" })
    .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));

  script.patchStatus = 200;
  const second = await provisionTortAgent(TEST_TORT);

  assert.equal(second.outcome, "updated");
  assert.equal(second.vapi_assistant_id, "asst_drift");

  const [row] = await db
    .select()
    .from(tortVoiceAgentsTable)
    .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
  assert.notEqual(row?.prompt_fingerprint, "stale-fingerprint");
  assert.equal(row?.last_error, null);
});

test("recreates the assistant when the upstream PATCH 404s", async () => {
  // Seed a row pointing at an assistant that no longer exists upstream,
  // with a drifted fingerprint so the service attempts a PATCH first.
  await db.insert(tortVoiceAgentsTable).values({
    tort_id: TEST_TORT,
    tort_label: TORT_REGISTRY[TEST_TORT]!.label,
    vapi_assistant_id: "asst_gone",
    status: "active",
    prompt_fingerprint: "stale-fingerprint",
  } as typeof tortVoiceAgentsTable.$inferInsert);

  script.patchStatus = 404;
  script.postId = "asst_reborn";
  const res = await provisionTortAgent(TEST_TORT);

  assert.equal(res.outcome, "created");
  assert.equal(res.vapi_assistant_id, "asst_reborn");
  assert.equal(res.error, null);

  const [row] = await db
    .select()
    .from(tortVoiceAgentsTable)
    .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
  assert.equal(row?.vapi_assistant_id, "asst_reborn");
});

test("errors (no Vapi call) when PUBLIC_API_BASE is unset", async () => {
  delete process.env["PUBLIC_API_BASE"];
  const savedDomains = process.env["REPLIT_DOMAINS"];
  delete process.env["REPLIT_DOMAINS"];
  // If a fetch leaks here it would be unscripted and reject anyway, but
  // the guard should short-circuit before any network call.
  script.rejectAll = true;
  try {
    const res = await provisionTortAgent(TEST_TORT);
    assert.equal(res.outcome, "error");
    assert.equal(res.vapi_assistant_id, null);
    assert.match(res.error ?? "", /PUBLIC_API_BASE/);

    const [row] = await db
      .select()
      .from(tortVoiceAgentsTable)
      .where(eq(tortVoiceAgentsTable.tort_id, TEST_TORT));
    assert.equal(row?.status, "error");
    assert.match(row?.last_error ?? "", /PUBLIC_API_BASE/);
  } finally {
    if (savedDomains !== undefined) process.env["REPLIT_DOMAINS"] = savedDomains;
  }
});

test("errors (no Vapi call) when the resolved integration has no api_key", async () => {
  // Strip the api_key from the seeded integration to drive the
  // NO_VAPI_KEY miss path, then restore it for later tests.
  const goodCreds = {
    api_key: encrypt("vapi_test_key", "integration:api_key", String(integrationId)),
    client_secret: encrypt("vapi_test_bearer", "integration:client_secret", String(integrationId)),
  };
  await db
    .update(integrationsTable)
    .set({
      config: {
        credentials: {
          client_secret: encrypt("vapi_test_bearer", "integration:client_secret", String(integrationId)),
        },
      },
    })
    .where(eq(integrationsTable.id, integrationId));

  script.rejectAll = true;
  try {
    const res = await provisionTortAgent(TEST_TORT);
    assert.equal(res.outcome, "error");
    assert.equal(res.vapi_assistant_id, null);
    assert.match(res.error ?? "", /api_key/i);
  } finally {
    await db
      .update(integrationsTable)
      .set({ config: { credentials: goodCreds } })
      .where(eq(integrationsTable.id, integrationId));
  }
});
