// Regression coverage for the credential-leak flagged in code review of
// Task #56: `sendVerificationEmail` MUST NOT emit the plaintext
// verification token to logs by default. The plaintext is an
// authentication credential — anyone with log access (operators,
// support tooling, third-party log sinks) can take over the pending
// account inside the 24h TTL if the link leaks.
//
// We exercise three branches:
//   (1) Default operation logs only safe metadata (token_fingerprint,
//       expires_in_hours) — never the plaintext token or the link.
//   (2) MTOS_LOG_VERIFICATION_LINK=1 in a non-production env reactivates
//       the dev-only plaintext-link log line so a developer without a
//       SendGrid integration can still complete verification locally.
//   (3) MTOS_LOG_VERIFICATION_LINK=1 in NODE_ENV=production is ignored
//       — the plaintext stays out of logs even if a stray env var leaks
//       into prod.
//
// We monkey-patch the singleton logger's methods so the test does not
// have to reach into pino's transport plumbing or rely on stdout
// capture (which is fragile under tsx + node:test).

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../logger.js";
import { sendVerificationEmail, hashVerificationToken } from "../email-verification.js";

type LogCall = { level: string; obj: Record<string, unknown>; msg: string };
const captured: LogCall[] = [];

// Stash the originals so we can restore them in afterEach. Using
// `unknown` then narrowing avoids fighting pino's overloaded signatures.
const original = {
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
};

const TEST_TOKEN = "a".repeat(64); // 64-hex matches the real token shape
const TEST_HASH = hashVerificationToken(TEST_TOKEN);

const ORIGINAL_OPT_IN = process.env["MTOS_LOG_VERIFICATION_LINK"];
const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_APP_URL = process.env["APP_PUBLIC_URL"];

// Stub the queue at the import-time level by overwriting the module's
// enqueueJob binding via a global flag. The email module catches enqueue
// failures, so even if this misfires the test still observes the log
// path. To keep the test hermetic we just let the real enqueueJob run
// against the live DB — the lib/queue.ts path tolerates a missing
// integration row at enqueue time (only fails at send time, which we
// don't exercise).
//
// Test isolation is sufficient because:
//   - we filter logs to the email-verification calls of interest
//     (issued / failed enqueue) and ignore unrelated chatter
//   - any rows we enqueue are flagged by token_fingerprint and not
//     consumed by any other test in the suite

before(() => {
  // Force a known APP_PUBLIC_URL so the link string is predictable,
  // and so the test does not depend on REPLIT_DOMAINS or a fallback.
  process.env["APP_PUBLIC_URL"] = "https://mtos.example.test";

  // Spy on each logger level by replacing the bound function. Pino's
  // type signature is overloaded; we coerce both ends to a permissive
  // shape because all we care about is the (obj, msg) call we make.
  (logger as unknown as { info: (obj: unknown, msg?: string) => void }).info = (
    obj: unknown,
    msg?: string,
  ) => {
    captured.push({
      level: "info",
      obj: (obj as Record<string, unknown>) ?? {},
      msg: msg ?? "",
    });
  };
  (logger as unknown as { warn: (obj: unknown, msg?: string) => void }).warn = (
    obj: unknown,
    msg?: string,
  ) => {
    captured.push({
      level: "warn",
      obj: (obj as Record<string, unknown>) ?? {},
      msg: msg ?? "",
    });
  };
  (logger as unknown as { error: (obj: unknown, msg?: string) => void }).error = (
    obj: unknown,
    msg?: string,
  ) => {
    captured.push({
      level: "error",
      obj: (obj as Record<string, unknown>) ?? {},
      msg: msg ?? "",
    });
  };
});

after(() => {
  (logger as unknown as { info: typeof original.info }).info = original.info;
  (logger as unknown as { warn: typeof original.warn }).warn = original.warn;
  (logger as unknown as { error: typeof original.error }).error = original.error;
  if (ORIGINAL_OPT_IN === undefined) delete process.env["MTOS_LOG_VERIFICATION_LINK"];
  else process.env["MTOS_LOG_VERIFICATION_LINK"] = ORIGINAL_OPT_IN;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  if (ORIGINAL_APP_URL === undefined) delete process.env["APP_PUBLIC_URL"];
  else process.env["APP_PUBLIC_URL"] = ORIGINAL_APP_URL;
});

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  // Reset env between tests so one's mutation doesn't bleed into the next.
  delete process.env["MTOS_LOG_VERIFICATION_LINK"];
  process.env["NODE_ENV"] = ORIGINAL_NODE_ENV ?? "test";
});

// Filter helper: ignore any logger calls that aren't from the
// email-verification module (e.g. enqueueJob's own success log) so the
// test only inspects the credential-leak surface.
function emailVerificationLogs(): LogCall[] {
  return captured.filter(
    (c) =>
      c.msg === "Email verification link issued" ||
      c.msg.startsWith("Email verification link emitted in plaintext") ||
      c.msg === "Failed to enqueue verification email job",
  );
}

test("(1) default operation never logs the plaintext token or full link", async () => {
  delete process.env["MTOS_LOG_VERIFICATION_LINK"];
  process.env["NODE_ENV"] = "development";

  await sendVerificationEmail("user@example.test", "Test User", TEST_TOKEN);

  const ours = emailVerificationLogs();
  assert.ok(ours.length >= 1, "must emit at least the issued-event log");
  for (const call of ours) {
    const blob = JSON.stringify(call);
    assert.ok(
      !blob.includes(TEST_TOKEN),
      `log call must not contain the plaintext token (level=${call.level} msg=${call.msg})`,
    );
    assert.ok(
      !blob.includes("/verify-email?token="),
      `log call must not contain the verification URL path with the live token (level=${call.level} msg=${call.msg})`,
    );
  }

  const issued = ours.find((c) => c.msg === "Email verification link issued");
  assert.ok(issued, "must emit the issued-event log");
  assert.equal(issued!.level, "info");
  assert.equal(issued!.obj["to"], "user@example.test");
  assert.equal(
    issued!.obj["token_fingerprint"],
    TEST_HASH.slice(0, 8),
    "issued event must carry an 8-hex SHA-256 prefix for log correlation",
  );
  assert.equal(issued!.obj["expires_in_hours"], 24);
  // Defensive: the issued event must NOT carry a `link` key under any
  // circumstance — the prod path has no business shipping a clickable
  // URL to log sinks.
  assert.equal(
    issued!.obj["link"],
    undefined,
    "issued event must not include a `link` field that could carry the plaintext token",
  );
});

test("(2) MTOS_LOG_VERIFICATION_LINK=1 in dev re-enables the plaintext-link log (operator escape hatch)", async () => {
  process.env["MTOS_LOG_VERIFICATION_LINK"] = "1";
  process.env["NODE_ENV"] = "development";

  await sendVerificationEmail("dev@example.test", "Dev User", TEST_TOKEN);

  const ours = emailVerificationLogs();
  const warn = ours.find(
    (c) => c.level === "warn" && typeof c.obj["link"] === "string",
  );
  assert.ok(warn, "dev opt-in must emit a warn-level log carrying the full link");
  const link = String(warn!.obj["link"]);
  assert.ok(
    link.includes(TEST_TOKEN),
    "dev opt-in log must include the full link the developer needs to click",
  );
  assert.match(
    warn!.msg,
    /never enable this in production/i,
    "dev opt-in log must call out the prod risk in the message body",
  );
});

test("(3) MTOS_LOG_VERIFICATION_LINK=1 is IGNORED when NODE_ENV=production (defence-in-depth)", async () => {
  process.env["MTOS_LOG_VERIFICATION_LINK"] = "1";
  process.env["NODE_ENV"] = "production";

  await sendVerificationEmail("prod@example.test", "Prod User", TEST_TOKEN);

  const ours = emailVerificationLogs();
  for (const call of ours) {
    const blob = JSON.stringify(call);
    assert.ok(
      !blob.includes(TEST_TOKEN),
      `production must NEVER emit the plaintext token, even with the dev opt-in env var set (level=${call.level} msg=${call.msg})`,
    );
  }
});
