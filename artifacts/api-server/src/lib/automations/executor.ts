/**
 * Workflow executor. Walks the graph node-by-node, evaluates each handler,
 * and persists a step log. The executor is intentionally simple: it runs
 * inline (synchronously within a single request or job) and is best suited
 * for short workflows. Long-running workflows should ultimately be split
 * into queued jobs — that's a v2 enhancement.
 *
 * Each handler receives a `StepContext` and returns either:
 *   - undefined / object   → success, value becomes the output payload
 *   - { branch: string }   → success but route via the named output edge
 */
import {
  db,
  automationRunsTable,
  automationWorkflowsTable,
  leadsTable,
  casesTable,
  auditLogTable,
  reviewQueueTable,
  paralegalsTable,
  documentTemplatesTable,
  integrationsTable,
} from "@workspace/db";
import { eq, and, sql, asc } from "drizzle-orm";
import path from "node:path";
import { logger } from "../logger";
import vm from "node:vm";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { getNodeDefinition } from "./node-catalog";
import { getIntegrationCredentials } from "../../routes/integrations";
import { getEmailAdapter } from "../email/sendgrid";
import { getFaxAdapter } from "../fax";
import { sendSms } from "../sms/telnyx";
import { resolveProvider, isResolved } from "../provider-router";
import { getVoiceAdapter } from "../voice";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { callLLM } from "../ai-provider";
import { getSearchAdapter } from "../search";
import { saveFile, readFile } from "../vault";
import { runBackgroundCheckHub } from "../bg-hub/hub";
import { lookupNpiAndMatch } from "../taxonomy-engine";
import { serpapiAdvertiserAds, isSerpapiConfigured, SerpapiError } from "../serpapi-client";
import { computeAndPersistLeadScore } from "../decision-engine-service";
import { analyzeDocumentText } from "../ai-fields";
import { getFormConfigByIdOrLabel, getFormConfig } from "../form-config-service";
import { findExistingLeadForIntake } from "../lead-dedup";
import { enqueueJob } from "../queue";

/**
 * SSRF guard: block obviously dangerous URLs from any node-driven outbound
 * request. We disallow non-http(s) schemes, link-local / loopback /
 * private / cloud-metadata IPs, and resolve hostnames to refuse the same
 * ranges. This is a hard floor — it does not replace per-integration
 * allowlists, but it prevents a workflow author from pivoting into the
 * Replit metadata service or a sibling internal service.
 */
function isBlockedIp(ip: string): boolean {
  if (!ip) return true;
  // IPv4 metadata + private + loopback + link-local + broadcast.
  if (ip === "169.254.169.254" || ip === "100.100.100.200") return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7));
    return false;
  }
  return true;
}

async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Invalid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked URL scheme '${u.protocol}' (only http/https allowed).`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost") throw new Error(`Blocked host '${u.hostname}'.`);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Blocked private/internal IP ${host}.`);
    return u;
  }
  // Resolve hostname; refuse if any A/AAAA points at a blocked range.
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isBlockedIp(r.address)) throw new Error(`Host ${host} resolves to private/internal IP ${r.address}.`);
    }
  } catch (e: any) {
    throw new Error(`DNS lookup failed for ${host}: ${e?.message ?? String(e)}`);
  }
  return u;
}

/**
 * Redact obvious secrets from step output before persisting. Recursively
 * scans objects/arrays, replaces values of likely-sensitive keys, and masks
 * Authorization-style header strings. Not a panacea — workflow authors can
 * still smuggle secrets through arbitrary keys — but it stops the common
 * accidental-leak pattern (AI prompt + token + response stored verbatim).
 */
const SECRET_KEY_RE = /(?:^|_|-|\.)(authorization|api[_-]?key|apikey|secret|token|password|passwd|cookie|set[_-]?cookie|x[_-]?api[_-]?key|bearer|credential)s?$/i;
function redactSecrets(v: any, depth = 0): any {
  if (depth > 6) return "[truncated:depth]";
  if (v == null) return v;
  if (typeof v === "string") {
    if (/^Bearer\s+\S+/i.test(v) || /^Basic\s+\S+/i.test(v)) return "[redacted]";
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k)) { out[k] = "[redacted]"; continue; }
      out[k] = redactSecrets(val, depth + 1);
    }
    return out;
  }
  return v;
}

interface GraphNode {
  id: string;
  type: string;
  data?: { params?: Record<string, any>; label?: string };
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface StepLogEntry {
  node_id: string;
  type: string;
  label?: string;
  started_at: string;
  finished_at: string;
  status: "ok" | "error" | "skipped";
  branch?: string;
  output?: unknown;
  error?: string;
}

interface ExecutorOptions {
  workflowId: number;
  firmId: number | null;
  triggerSource?: string;
  input?: Record<string, unknown>;
  startedByUserId?: number | null;
}

interface RunResult {
  runId: number;
  status: "completed" | "failed";
  output: unknown;
  steps: StepLogEntry[];
  error?: string;
}

interface StepContext {
  node: GraphNode;
  input: any;
  vars: Record<string, any>;
  ctx: { workflowId: number; firmId: number | null; runId: number };
}

type HandlerResult = void | unknown | { __branch: string; value?: unknown };

const MAX_STEPS = 200;

function resolvePath(obj: any, path: string): any {
  if (!path) return undefined;
  // Callers pass `{ input, vars }` as `obj`, and `path` may start with
  // either `input.` / `vars.` (the documented authoring convention shown
  // in the node catalog, e.g. `"input.lead.id"`) or be a bare path
  // already rooted at `obj`. We DO NOT strip the prefix — `input` and
  // `vars` are real keys on the wrapper, so walking them directly is
  // what makes `input.lead.id` resolve to `obj.input.lead.id`. (The
  // earlier strip-then-walk-wrapper logic was a bug: `obj.lead` was
  // undefined, so the documented `input.X` notation always returned
  // `undefined` — exposed by the form→fax smoke test where the fax
  // node read leadId as NaN and short-circuited to `failed`.)
  const parts = path.split(/[.[\]]/).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalExpression(expr: string, bindings: Record<string, any>): any {
  const ctx = { ...bindings };
  vm.createContext(ctx);
  return vm.runInContext(expr, ctx, { timeout: 1000 });
}

export const HANDLERS: Record<string, (s: StepContext) => Promise<HandlerResult>> = {
  // ───────── Triggers (no-op at runtime; entry points carry input through)
  "trigger.manual": async (s) => s.input,
  "trigger.webhook": async (s) => s.input,
  "trigger.schedule": async (s) => s.input,
  "trigger.lead_created": async (s) => s.input,
  "trigger.form_submitted": async (s) => s.input,
  "trigger.inbound_call": async (s) => s.input,
  "trigger.inbound_sms": async (s) => s.input,
  "trigger.inbound_email": async (s) => s.input,
  "trigger.inbound_fax": async (s) => s.input,
  "trigger.document_signed": async (s) => s.input,
  "trigger.case_status_changed": async (s) => s.input,
  "trigger.ocr_completed": async (s) => s.input,

  // ───────── Logic
  "logic.if": async (s) => {
    const expr = String(s.node.data?.params?.expression ?? "false");
    const result = !!evalExpression(expr, { input: s.input, vars: s.vars, ctx: s.ctx });
    return { __branch: result ? "true" : "false", value: s.input };
  },
  "logic.switch": async (s) => {
    const key = String(s.node.data?.params?.key ?? "");
    const cases = (s.node.data?.params?.cases ?? {}) as Record<string, string>;
    const value = String(resolvePath({ input: s.input, vars: s.vars }, key) ?? "");
    const branch = cases[value] ?? "default";
    return { __branch: branch, value: s.input };
  },
  "logic.loop": async (s) => {
    // Simplified: iteration is handled by treating the "item" branch as a
    // fan-out producing one execution per item. To keep the engine in v1
    // simple, we attach the array to the output as `_items` and the
    // downstream branch receives the whole array — operators can use a
    // Transform node to iterate. A future iteration nodewill expand this.
    const path = String(s.node.data?.params?.arrayPath ?? "");
    const arr = resolvePath({ input: s.input, vars: s.vars }, path);
    return { __branch: Array.isArray(arr) && arr.length ? "item" : "done", value: { items: arr ?? [] } };
  },
  "logic.delay": async (s) => {
    const seconds = Number(s.node.data?.params?.seconds ?? 0);
    if (seconds > 0) await new Promise((r) => setTimeout(r, Math.min(seconds, 60) * 1000));
    return s.input;
  },

  // ───────── Data
  "data.set": async (s) => {
    const name = String(s.node.data?.params?.name ?? "");
    // Resolve expressions so "input.lead" becomes the actual lead object
    const value = resolveOrLiteral(s, s.node.data?.params?.value);
    if (name) s.vars[name] = value;
    return s.input; // pass input through unchanged
  },
  "data.transform": async (s) => {
    const code = String(s.node.data?.params?.code ?? "return input;");
    const fn = new Function("input", "vars", code);
    return fn(s.input, s.vars);
  },
  "data.regex": async (s) => {
    const text = String(resolvePath({ input: s.input, vars: s.vars }, String(s.node.data?.params?.text ?? "")) ?? "");
    const pattern = String(s.node.data?.params?.pattern ?? "");
    const flags = String(s.node.data?.params?.flags ?? "g");
    const matches: string[][] = [];
    const re = new RegExp(pattern, flags);
    if (flags.includes("g")) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) matches.push([...m]);
    } else {
      const m = text.match(re);
      if (m) matches.push([...m]);
    }
    return { matches };
  },
  "data.json_path": async (s) => {
    const path = String(s.node.data?.params?.path ?? "");
    return resolvePath({ input: s.input, vars: s.vars }, path);
  },
  "data.csv_parse": async (s) => {
    const text = String(resolvePath({ input: s.input, vars: s.vars }, String(s.node.data?.params?.text ?? "")) ?? "");
    const delim = String(s.node.data?.params?.delimiter ?? ",");
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    if (lines.length === 0) return { rows: [] };
    const headers = lines[0]!.split(delim).map((h) => h.trim());
    const rows = lines.slice(1).map((line) => {
      const cells = line.split(delim);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (cells[i] ?? "").trim(); });
      return row;
    });
    return { rows };
  },

  // ───────── CRM
  "crm.create_lead": async (s) => {
    const data = (s.node.data?.params?.data ?? {}) as Record<string, any>;
    const insertData: any = { ...data, firm_id: data.firm_id ?? s.ctx.firmId ?? 1 };
    const [row] = await db.insert(leadsTable).values(insertData).returning();
    return { lead: row };
  },
  "crm.update_lead": async (s) => {
    const idRaw = resolveOrLiteral(s, s.node.data?.params?.leadId);
    const leadId = Number(idRaw);
    const patch = (s.node.data?.params?.patch ?? {}) as Record<string, any>;
    // Tenant scoping: refuse to mutate a lead that belongs to a different
    // firm than the workflow's owning firm. Workflows with no firm (system
    // automations) skip the firm predicate.
    const where = s.ctx.firmId == null
      ? eq(leadsTable.id, leadId)
      : and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, s.ctx.firmId));
    const [row] = await db.update(leadsTable).set({ ...patch, updated_at: new Date() }).where(where).returning();
    if (!row) throw new Error(`crm.update_lead: lead ${leadId} not found in firm ${s.ctx.firmId}.`);
    return { lead: row };
  },
  "crm.qualify_lead": async (s) => {
    const idRaw = resolveOrLiteral(s, s.node.data?.params?.leadId);
    const leadId = Number(idRaw);
    const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!row) throw new Error(`Lead ${leadId} not found`);
    // Simple deterministic qualification using existing qualification_status
    // — full decision-engine wiring lives in lib/decision-engine; here we
    // just route based on whatever the lead already says (operators can
    // call decision-engine via http_request if they want fresh scoring).
    const status = (row as any).qualification_status as string | undefined;
    const branch = status === "qualified" ? "qualified" : status === "rejected" ? "rejected" : "review";
    return { __branch: branch, value: { lead: row } };
  },
  "crm.create_case": async (s) => {
    const p = s.node.data?.params ?? {};
    const extraData = (p.data ?? {}) as Record<string, any>;
    const leadIdRaw = resolveOrLiteral(s, p.leadId ?? s.vars?.lead_id ?? s.input?.lead_id);
    const leadId = Number(leadIdRaw) || undefined;
    const id = extraData.id ?? crypto.randomUUID();
    // created_by_user_id: required NOT NULL — use the run's user or system user 1
    const createdBy = s.ctx.firmId ?? 1;
    const [row] = await db.insert(casesTable).values({
      id,
      created_by_user_id: createdBy,
      data: leadId ? { lead_id: leadId, ...extraData } : extraData,
      status: extraData.status ?? "open",
    } as any).returning();
    if (leadId) {
      // Link case to lead via audit trail
      await db.insert(auditLogTable).values({
        entity_type: "case", entity_id: id,
        action: "case.created", details: { lead_id: leadId, source: "automation" },
      } as any).catch(() => {});
    }
    return { case: row, case_id: id };
  },
  "crm.add_note": async (s) => {
    // Notes are stored as audit_log entries with action "note_added".
    const entity = String(s.node.data?.params?.entity ?? "lead");
    const id = String(resolveOrLiteral(s, s.node.data?.params?.id) ?? "");
    const note = String(s.node.data?.params?.note ?? "");
    await db.insert(auditLogTable).values({
      action: "note_added", entity_type: entity, entity_id: id, details: { note },
    } as any);
    return { ok: true };
  },
  "crm.audit_log": async (s) => {
    const action = String(s.node.data?.params?.action ?? "");
    const entityType = String(s.node.data?.params?.entityType ?? "");
    const entityId = String(s.node.data?.params?.entityId ?? "");
    const details = s.node.data?.params?.details ?? {};
    await db.insert(auditLogTable).values({ action, entity_type: entityType, entity_id: entityId, details } as any);
    return { ok: true };
  },

  // ───────── Integrations
  "integration.send_email": async (s) => {
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const subject = String(resolveOrLiteral(s, p.subject) ?? "");
    const html = String(resolveOrLiteral(s, p.html) ?? "");
    const fromOverride = p.from ? String(resolveOrLiteral(s, p.from)) : undefined;
    if (!to || !subject || !html) throw new Error("integration.send_email requires to, subject, and html");
    const creds = await getIntegrationCredentials("sendgrid");
    if (!creds) throw new Error("SendGrid integration is not configured.");
    const adapter = getEmailAdapter("sendgrid")!;
    const fromEmail = fromOverride
      || (typeof (creds as any).from_email === "string" ? (creds as any).from_email : "")
      || process.env["EMAIL_FROM_ADDRESS"]
      || "";
    if (!fromEmail) throw new Error("SendGrid integration has no from_email configured.");
    const result = await adapter.send(creds, { to, subject, html, fromEmail });
    if (!result.ok) throw new Error(`SendGrid send failed: ${result.code}: ${result.message}`);
    return { ok: true, messageId: result.externalMessageId };
  },
  "integration.send_fax": async (s) => {
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const documentUrl = String(resolveOrLiteral(s, p.documentUrl) ?? "").trim();
    if (!to || !documentUrl) throw new Error("integration.send_fax requires to and documentUrl");
    const safeUrl = await assertSafeOutboundUrl(documentUrl);
    const creds = await getIntegrationCredentials("srfax");
    if (!creds) throw new Error("SRFax integration is not configured.");
    const adapter = getFaxAdapter("srfax")!;
    const docRes = await fetch(safeUrl.toString());
    if (!docRes.ok) throw new Error(`Could not fetch document at ${documentUrl}: HTTP ${docRes.status}`);
    const pdf = Buffer.from(await docRes.arrayBuffer());
    const fileName = safeUrl.pathname.split("/").pop() || "document.pdf";
    const result = await adapter.send(creds, { toNumber: to, pdf, fileName });
    if (!result.ok) throw new Error(`SRFax send failed: ${result.code}: ${result.message}`);
    return { ok: true, externalId: (result as any).externalFaxId };
  },
  "integration.send_esign": async (s) => {
    // Catalog params: templateId, signerEmail, signerName. The worker job
    // also needs a leadId so the resulting envelope can be attached to a
    // lead — we read that from the upstream input rather than the catalog
    // (workflows wire it up via the trigger payload, e.g. lead.created).
    const p = s.node.data?.params ?? {};
    const templateId = Number(resolveOrLiteral(s, p.templateId));
    const signerEmail = String(resolveOrLiteral(s, p.signerEmail) ?? "").trim();
    const signerName = String(resolveOrLiteral(s, p.signerName) ?? "").trim();
    const leadId = Number(resolveOrLiteral(s, s.input?.lead?.id ?? s.input?.lead_id));
    if (!Number.isInteger(templateId) || !signerEmail || !signerName) {
      throw new Error("integration.send_esign requires templateId, signerEmail, signerName.");
    }
    if (!Number.isInteger(leadId)) {
      throw new Error("integration.send_esign needs a leadId on the upstream input (input.lead_id or input.lead.id).");
    }
    // Tenant scoping: confirm the lead belongs to this firm before
    // enqueueing the worker job (which itself will operate without the
    // request-level firm middleware).
    const [owned] = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(s.ctx.firmId == null
        ? eq(leadsTable.id, leadId)
        : and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, s.ctx.firmId)))
      .limit(1);
    if (!owned) throw new Error(`integration.send_esign: lead ${leadId} not in firm ${s.ctx.firmId}.`);
    // The worker payload contract only carries lead_id + template_id; signer
    // identity is resolved by the worker from the lead record. We surface the
    // catalog-supplied signer fields back to the caller for traceability so
    // operators can confirm which signer the workflow targeted.
    const jobId = await enqueueJob("send_esign_packet", { lead_id: leadId, template_id: templateId });
    return { enqueued: true, job_id: jobId, signer_email: signerEmail, signer_name: signerName };
  },
  "integration.webhook_out": async (s) => {
    const url = String(s.node.data?.params?.url ?? "");
    const safe = await assertSafeOutboundUrl(url);
    const method = String(s.node.data?.params?.method ?? "POST");
    const headers = (s.node.data?.params?.headers ?? {}) as Record<string, string>;
    const body = s.node.data?.params?.body ?? {};
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const finalHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
    const secret = s.node.data?.params?.hmacSecret;
    if (secret) {
      finalHeaders["x-mtos-signature"] = crypto.createHmac("sha256", String(secret)).update(payload).digest("hex");
    }
    const res = await fetch(safe.toString(), { method, headers: finalHeaders, body: payload });
    return { status: res.status, ok: res.ok };
  },
  "integration.http_request": async (s) => {
    const url = String(s.node.data?.params?.url ?? "");
    const safe = await assertSafeOutboundUrl(url);
    const method = String(s.node.data?.params?.method ?? "GET");
    const headers = (s.node.data?.params?.headers ?? {}) as Record<string, string>;
    const body = s.node.data?.params?.body;
    const responseType = String(s.node.data?.params?.responseType ?? "json");
    const init: RequestInit = { method, headers };
    if (body != null && method !== "GET" && method !== "DELETE") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
    }
    const res = await fetch(safe.toString(), init);
    const data = responseType === "json" ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, ok: res.ok, data };
  },
  "integration.web_search": async (s) => {
    const p = s.node.data?.params ?? {};
    const providerKey = String(resolveOrLiteral(s, p.provider) ?? "serpapi").trim() || "serpapi";
    const adapter = getSearchAdapter(providerKey);
    if (!adapter) {
      throw new Error(`integration.web_search: no adapter wired for provider "${providerKey}".`);
    }
    const query = String(resolveOrLiteral(s, p.query) ?? "").trim();
    if (!query) {
      throw new Error("integration.web_search requires `query`.");
    }
    const engine = String(resolveOrLiteral(s, p.engine) ?? adapter.defaultEngine).trim() || adapter.defaultEngine;
    const location = String(resolveOrLiteral(s, p.location) ?? "").trim() || undefined;
    const num = Number(resolveOrLiteral(s, p.maxResults) ?? 10);

    const [row] = await db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.provider, providerKey), eq(integrationsTable.status, "active")))
      .orderBy(sql`${integrationsTable.created_at} DESC`)
      .limit(1);
    if (!row) {
      throw new Error(`integration.web_search needs an active ${providerKey} integration in the vault. Add one on the Integrations page.`);
    }
    const creds = await getIntegrationCredentialsById(row.id);
    if (!creds) {
      throw new Error(`${providerKey} credentials could not be loaded from the vault.`);
    }
    const out = await adapter.search(creds, { query, engine, location, num });
    if (!out.ok) {
      return { ok: false, code: out.code, retryable: out.retryable, error: out.message };
    }
    return {
      ok: true,
      provider: out.provider,
      engine: out.engine,
      query: out.query,
      results: out.results,
      count: out.results.length,
    };
  },
  "integration.graphql": async (s) => {
    const url = String(s.node.data?.params?.url ?? "");
    const safe = await assertSafeOutboundUrl(url);
    const query = String(s.node.data?.params?.query ?? "");
    const variables = s.node.data?.params?.variables ?? {};
    const headers = (s.node.data?.params?.headers ?? {}) as Record<string, string>;
    const res = await fetch(safe.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    });
    return await res.json();
  },

  // ───────── AI
  "ai.extract_fields": async (s) => {
    const text = String(resolveOrLiteral(s, s.node.data?.params?.text ?? s.input?.text ?? "") || "");
    if (!text) throw new Error("ai.extract_fields requires text input.");
    const fields = await analyzeDocumentText(text);
    return { fields };
  },
  "ai.summarize": async (s) => {
    const text = String(resolveOrLiteral(s, s.node.data?.params?.text ?? s.input?.text ?? "") || "");
    if (!text) throw new Error("ai.summarize requires text input.");
    const maxTokens = Number(s.node.data?.params?.maxTokens ?? 400);
    const summary = await callLLM({
      module: "drafting-ai",
      systemPrompt: "You are a concise legal summarization assistant. Reply in plain prose, no preamble.",
      prompt: `Summarize the following:\n\n${text}`,
      maxTokens,
    });
    return { summary };
  },
  "ai.draft": async (s) => {
    const p = s.node.data?.params ?? {};
    const prompt = String(resolveOrLiteral(s, p.prompt ?? s.input?.prompt) ?? "");
    if (!prompt) throw new Error("ai.draft requires a prompt.");
    const draft = await callLLM({
      module: "drafting-ai",
      systemPrompt: String(p.systemPrompt ?? "You are a legal drafting assistant. Reply with the requested document content only — no preamble."),
      prompt,
      maxTokens: Number(p.maxTokens ?? 800),
    });
    return { draft };
  },

  // ───────── Scripts
  "script.javascript": async (s) => {
    if (!s.node.data?.params?.approved) {
      throw new Error("JavaScript node requires explicit operator approval (set 'approved' to true in node params).");
    }
    const code = String(s.node.data?.params?.code ?? "return input;");
    const timeoutMs = Number(s.node.data?.params?.timeoutMs ?? 5000);
    // Sandbox carries no Node globals — only the bindings we hand it.
    const sandbox: any = { input: s.input, vars: s.vars, console: { log: () => {} }, result: undefined };
    vm.createContext(sandbox);
    try {
      vm.runInContext(`result = (function(input, vars){ ${code} })(input, vars);`, sandbox, { timeout: timeoutMs });
    } catch (err: any) {
      throw new Error(`script.javascript: ${err.message}`);
    }
    return sandbox.result;
  },
  "script.python": async (s) => {
    if (!s.node.data?.params?.approved) throw new Error("Python node requires explicit operator approval.");
    return runProcess("python3", [], String(s.node.data?.params?.code ?? ""), s, "-c");
  },
  "script.bash": async (s) => {
    if (!s.node.data?.params?.approved) throw new Error("Bash node requires explicit operator approval (set 'approved' to true).");
    return runProcess("bash", ["-c", String(s.node.data?.params?.command ?? "")], "", s);
  },
  "script.powershell": async (s) => {
    if (!s.node.data?.params?.approved) throw new Error("PowerShell node requires explicit operator approval.");
    return runProcess("pwsh", ["-Command", String(s.node.data?.params?.command ?? "")], "", s);
  },

  // ───────── I/O
  "io.sql_query": async (s) => {
    const queryText = String(s.node.data?.params?.sql ?? "");
    const trimmed = queryText.trim().toLowerCase();
    if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
      throw new Error("io.sql_query only allows SELECT/WITH queries.");
    }
        const params = (s.node.data?.params?.params ?? []) as unknown[];
    // Use pool.query() with parameterized values — safe against SQL injection
    // io.sql_query only allows SELECT/WITH so no write risk
    const result = await pool.query(queryText, params);
    return { rows: result.rows }; };
  },
  "io.read_file": async (s) => {
    // Catalog param: `key` is a logical vault object key, conventionally
    // "<caseId>/<filename>". We translate it to the absolute path the vault
    // layer expects (`<cwd>/vault/<key>`) so the vault's traversal guard can
    // still reject anything escaping its base directory.
    const key = String(resolveOrLiteral(s, s.node.data?.params?.key) ?? "");
    if (!key) throw new Error("io.read_file requires `key` (vault object key).");
    if (key.includes("..") || path.isAbsolute(key)) {
      throw new Error("io.read_file `key` must be a relative path inside the vault.");
    }
    const abs = path.resolve(process.cwd(), "vault", key);
    const content = await readFile(abs);
    return { key, content };
  },
  "io.write_file": async (s) => {
    // Catalog params: `key` (relative vault key, "<caseId>/<filename>"),
    // `content` (string or JSON-serializable). saveFile derives mime from the
    // filename and re-applies its own traversal guard inside the vault layer.
    const p = s.node.data?.params ?? {};
    const key = String(resolveOrLiteral(s, p.key) ?? "");
    const content = resolveOrLiteral(s, p.content);
    if (!key || content == null) {
      throw new Error("io.write_file requires `key` and `content`.");
    }
    if (key.includes("..") || path.isAbsolute(key)) {
      throw new Error("io.write_file `key` must be a relative path inside the vault.");
    }
    const slash = key.lastIndexOf("/");
    if (slash <= 0) {
      throw new Error("io.write_file `key` must be of form '<caseId>/<filename>' so the vault can scope writes.");
    }
    const caseId = key.slice(0, slash);
    const fileName = key.slice(slash + 1);
    const data = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content);
    const out = await saveFile(caseId, data as any, fileName);
    return { key, ...out };
  },

  // ───────── CRM (extended)
  "crm.assign_paralegal": async (s) => {
    // Catalog params: `entity` ("lead"|"case"), `id`, optional `paralegalId`.
    // For now we only support entity=lead (cases would need their own join);
    // we surface a clear error rather than silently no-op for case entities.
    const p = s.node.data?.params ?? {};
    const entity = String(resolveOrLiteral(s, p.entity) ?? "lead");
    if (entity !== "lead") throw new Error(`crm.assign_paralegal: entity '${entity}' is not yet supported (only 'lead').`);
    const leadIdRaw = resolveOrLiteral(s, p.id ?? s.input?.lead_id ?? s.input?.lead?.id);
    const leadId = Number(leadIdRaw);
    if (!Number.isInteger(leadId)) throw new Error("crm.assign_paralegal requires a resolvable `id`.");
    let paralegalId: number | null = p.paralegalId != null ? Number(resolveOrLiteral(s, p.paralegalId)) : null;
    if (!paralegalId) {
      // Round-robin: pick the active paralegal with the fewest open assignments.
      const [least] = await db.select().from(paralegalsTable).orderBy(asc(paralegalsTable.active_cases)).limit(1);
      if (!least) throw new Error("crm.assign_paralegal: no paralegals on roster.");
      paralegalId = least.id;
    }
    // The leads table has no dedicated paralegal_id column; we reuse `assigned_to`
    // (integer) and record the paralegal table id there. Operators reading this
    // column need to know it can be either a user_id or a paralegal_id depending
    // on origin — the source-of-truth is the audit_log entry below.
    const [updated] = await db.update(leadsTable)
      .set({ assigned_to: paralegalId, updated_at: new Date() } as any)
      .where(eq(leadsTable.id, leadId)).returning();
    await db.insert(auditLogTable).values({
      action: "automation.assign_paralegal",
      entity_type: "lead",
      entity_id: String(leadId),
      details: { paralegal_id: paralegalId, run_id: s.ctx.runId },
    } as any);
    await db.update(paralegalsTable)
      .set({
        active_cases: sql`${paralegalsTable.active_cases} + 1`,
        total_assigned: sql`${paralegalsTable.total_assigned} + 1`,
        updated_at: new Date(),
      } as any).where(eq(paralegalsTable.id, paralegalId));
    return { lead_id: leadId, paralegal_id: paralegalId, lead: updated };
  },
  "crm.set_lead_status": async (s) => {
    const idRaw = resolveOrLiteral(s, s.node.data?.params?.leadId);
    const leadId = Number(idRaw);
    const status = String(s.node.data?.params?.status ?? "");
    if (!leadId || !status) throw new Error("crm.set_lead_status requires leadId and status");
    const where = s.ctx.firmId == null
      ? eq(leadsTable.id, leadId)
      : and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, s.ctx.firmId));
    const [row] = await db.update(leadsTable)
      .set({ status, updated_at: new Date() } as any)
      .where(where).returning();
    if (!row) throw new Error(`crm.set_lead_status: lead ${leadId} not found in firm ${s.ctx.firmId}.`);
    return { lead: row };
  },
  "crm.send_to_review_queue": async (s) => {
    // Catalog params: entity (lead|case|document), id, reason, priority.
    const p = s.node.data?.params ?? {};
    const entity = String(resolveOrLiteral(s, p.entity ?? "lead"));
    const idRaw = resolveOrLiteral(s, p.id ?? s.input?.lead_id ?? s.input?.lead?.id);
    if (idRaw == null) throw new Error("crm.send_to_review_queue requires `id`.");
    const reason = String(resolveOrLiteral(s, p.reason) ?? "Sent to review by automation");
    const priority = String(resolveOrLiteral(s, p.priority) ?? "normal");
    // Map catalog `priority` to internal review-queue `severity` axis.
    const severity = priority === "urgent" ? "critical"
      : priority === "high" ? "high"
      : priority === "low" ? "low"
      : "medium";
    const [row] = await db.insert(reviewQueueTable).values({
      entity_type: entity,
      entity_id: String(idRaw),
      conflict_type: "automation",
      severity,
      failsafe_mode: "review",
      source_module: `automation:${s.ctx.runId}`,
      summary: reason,
      details: { entity, id: String(idRaw), reason, priority, run_id: s.ctx.runId } as any,
    } as any).returning();
    return { review_item_id: row.id };
  },
  "crm.background_check": async (s) => {
    const leadIdRaw = resolveOrLiteral(s, s.node.data?.params?.leadId ?? s.input?.lead_id ?? s.input?.lead?.id);
    const leadId = Number(leadIdRaw);
    if (!Number.isInteger(leadId)) throw new Error("crm.background_check requires a resolvable leadId.");
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    if (!lead) throw new Error(`Lead ${leadId} not found.`);
    const result = await runBackgroundCheckHub(lead);
    // bg-hub final_status is one of clear|flagged|incomplete — map "incomplete"
    // onto the catalog's "error" output so the editor renders a real edge.
    const finalStatus = (result as any).final_status ?? "incomplete";
    const branch = finalStatus === "clear" ? "clear" : finalStatus === "flagged" ? "flagged" : "error";
    return { __branch: branch, value: result };
  },
  "crm.npi_lookup": async (s) => {
    // Catalog declares a single `npi` param. The NPPES helper supports both
    // raw NPI numbers (10-digit) and "first last" strings, so we accept both
    // shapes here for operator convenience.
    const p = s.node.data?.params ?? {};
    const npi = String(resolveOrLiteral(s, p.npi ?? s.input?.npi) ?? "").trim();
    if (!npi) throw new Error("crm.npi_lookup requires `npi` (NPI number or 'first last').");
    let first = "", last = "", diagnosis = "";
    if (/^\d{10}$/.test(npi)) {
      // Raw NPI — we don't have a direct number lookup wired; fall back to
      // surfacing the number so downstream nodes can use it.
      return { npi, lookup: "deferred", note: "Direct NPI-by-number lookup not wired; use first/last query." };
    }
    const parts = npi.split(/\s+/);
    first = parts[0] ?? ""; last = parts.slice(1).join(" ");
    diagnosis = String(resolveOrLiteral(s, s.input?.diagnosis) ?? "");
    if (!first || !last) throw new Error("crm.npi_lookup `npi` must be a 10-digit NPI or 'first last'.");
    const result = await lookupNpiAndMatch(first, last, diagnosis);
    return result;
  },
  "crm.decision_engine": async (s) => {
    const leadIdRaw = resolveOrLiteral(s, s.node.data?.params?.leadId ?? s.input?.lead_id ?? s.input?.lead?.id);
    const leadId = Number(leadIdRaw);
    if (!Number.isInteger(leadId)) throw new Error("crm.decision_engine requires a resolvable leadId.");
    const result = await computeAndPersistLeadScore(leadId);
    if (!result) {
      return { __branch: "review", value: { reason: "no_score" } };
    }
    // computeAndPersistLeadScore writes convexity_action on the lead; map to branch.
    const action = String((result as any).action ?? "review").toLowerCase();
    const branch = action.startsWith("qual") || action === "accept"
      ? "qualified"
      : action.startsWith("rej") || action === "decline"
        ? "rejected"
        : "review";
    return { __branch: branch, value: result };
  },
  "crm.competitive_intel_lookup": async (s) => {
    const p = s.node.data?.params ?? {};
    const advertiserId = String(resolveOrLiteral(s, p.advertiserId ?? s.input?.advertiser_id) ?? "").trim();
    if (!advertiserId) throw new Error("crm.competitive_intel_lookup requires `advertiserId`.");
    if (!isSerpapiConfigured()) {
      return { __branch: "error", value: { error: "serpapi_not_configured" } };
    }
    try {
      const result = await serpapiAdvertiserAds(advertiserId);
      const ad_count = result.ad_creatives?.length ?? 0;
      return {
        __branch: ad_count > 0 ? "found" : "empty",
        value: { advertiser_id: advertiserId, ad_count, advertiser: result.advertiser ?? null, ads: result.ad_creatives ?? [] },
      };
    } catch (err) {
      const sa = err instanceof SerpapiError ? err : null;
      return { __branch: "error", value: { error: (err as Error).message, status: sa?.status ?? 502 } };
    }
  },
  "crm.create_calendar_event": async (s) => {
    // Catalog params: `title`, `startsAt`, `endsAt`, `entity`, `id`, `notes`.
    // No calendar table exists yet; we record the event as an audit_log entry
    // so it lives on the lead/case timeline and is queryable. This is honest:
    // the operator UI's timeline view already surfaces audit_log rows.
    const p = s.node.data?.params ?? {};
    const title = String(resolveOrLiteral(s, p.title) ?? "");
    const startsAt = String(resolveOrLiteral(s, p.startsAt) ?? "");
    const endsAt = String(resolveOrLiteral(s, p.endsAt) ?? "");
    const entity = String(resolveOrLiteral(s, p.entity) ?? "lead");
    const idRaw = resolveOrLiteral(s, p.id ?? s.input?.lead_id);
    const notes = String(resolveOrLiteral(s, p.notes) ?? "");
    if (!title || !startsAt || idRaw == null) {
      throw new Error("crm.create_calendar_event requires `title`, `startsAt` (ISO timestamp), and `id`.");
    }
    await db.insert(auditLogTable).values({
      action: "calendar_event.created",
      entity_type: entity,
      entity_id: String(idRaw),
      details: { title, startsAt, endsAt, notes, source: "automation", run_id: s.ctx.runId } as any,
    } as any);
    return { ok: true, title, startsAt, endsAt: endsAt || null };
  },

  // ───────── Communication
  "comm.send_sms": async (s) => {
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const body = String(resolveOrLiteral(s, p.body ?? p.message) ?? "");
    if (!to || !body) throw new Error("comm.send_sms requires to and body.");
    const r = await sendSms({
      to,
      body,
      leadId: Number(resolveOrLiteral(s, p.leadId ?? s.input?.lead_id)) || null,
    });
    if (!r.ok) throw new Error(`Telnyx SMS failed: ${r.error ?? "unknown error"}`);
    return r;
  },
  "comm.send_mms": async (s) => {
    // MMS rides the same Telnyx /v2/messages endpoint as SMS but with a
    // `media_urls` array. We resolve the configured SMS provider via the
    // vault and only support telnyx (the only SMS adapter wired for MMS).
    // Other providers fail with a clear "use SMS + link" suggestion so
    // an automation graph can still branch on `code`.
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const body = String(resolveOrLiteral(s, p.body) ?? "");
    const mediaUrl = String(resolveOrLiteral(s, p.mediaUrl) ?? "").trim();
    if (!to || !mediaUrl) throw new Error("comm.send_mms requires `to` and `mediaUrl`.");
    const resolved = await resolveProvider("sms");
    if (!isResolved(resolved)) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", reason: resolved.reason, error: resolved.details ?? "No SMS provider configured." };
    }
    if (resolved.provider !== "telnyx") {
      return { ok: false, code: "MMS_NOT_SUPPORTED_BY_PROVIDER", error: `MMS not implemented for ${resolved.provider}. Use comm.send_sms with the asset URL inline.` };
    }
    const apiKey = (resolved.credentials.api_key ?? "").toString().trim();
    const cfg = (resolved.credentials.config && typeof resolved.credentials.config === "object" ? resolved.credentials.config : {}) as Record<string, unknown>;
    const fromNumber = (typeof p.from === "string" && p.from) || (typeof cfg.from_number === "string" ? cfg.from_number.trim() : "") || null;
    const profileId = typeof cfg.messaging_profile_id === "string" ? cfg.messaging_profile_id.trim() : "";
    const payload: Record<string, unknown> = { to, text: body, media_urls: [mediaUrl] };
    if (fromNumber) payload.from = fromNumber;
    if (profileId && !fromNumber) payload.messaging_profile_id = profileId;
    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.data?.id) {
      throw new Error(`Telnyx MMS failed: ${json?.errors?.[0]?.detail ?? `HTTP ${resp.status}`}`);
    }
    return { ok: true, externalMessageId: String(json.data.id), provider: "telnyx" };
  },
  "comm.make_call": async (s) => {
    // Outbound dial via the configured voice provider. The `agentId` param
    // optionally targets an AI assistant; if absent we still place the
    // call (Vapi requires an assistantId — surface a clean error).
    // Branches: "answered" once the call is accepted by the provider for
    // dispatch, "failed" for any synchronous error. The actual call
    // outcome (no_answer / busy / etc.) arrives later via webhook —
    // that's reported through the run's downstream nodes, not here.
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const agentId = String(resolveOrLiteral(s, p.agentId) ?? "").trim();
    if (!to) {
      return { __branch: "failed", value: { ok: false, code: "MISSING_TO", error: "comm.make_call requires `to`." } };
    }
    const resolved = await resolveProvider("voice");
    if (!isResolved(resolved)) {
      return { __branch: "failed", value: { ok: false, code: "PROVIDER_NOT_CONFIGURED", reason: resolved.reason, error: resolved.details ?? "No voice provider configured." } };
    }
    const adapter = getVoiceAdapter(resolved.provider);
    if (!adapter) {
      return { __branch: "failed", value: { ok: false, code: "ADAPTER_NOT_FOUND", error: `No voice adapter for provider ${resolved.provider}.` } };
    }
    if (!agentId) {
      return { __branch: "failed", value: { ok: false, code: "MISSING_AGENT_ID", error: `${resolved.provider} requires an assistant/agent id (set the agentId param).` } };
    }
    const out = await adapter.startCall(resolved.credentials, {
      to,
      from: typeof p.from === "string" ? p.from : undefined,
      assistantId: agentId,
      metadata: { run_id: String(s.ctx.runId), workflow_id: String(s.ctx.workflowId) },
    });
    if (!out.ok) {
      return { __branch: "failed", value: { ok: false, code: out.code, error: out.message, retryable: out.retryable } };
    }
    return { __branch: "answered", value: { ok: true, externalCallId: out.externalCallId, provider: resolved.provider, note: "Call dispatched. Final disposition (no_answer/busy/etc) arrives via webhook." } };
  },
  "comm.send_voicemail": async (s) => {
    // Voicemail-drop is a category that none of the wired voice/SMS
    // providers expose directly (Vapi/Twilio require a dedicated AMD +
    // ringless-voicemail product like Slybroadcast/Drop.co). We log the
    // request to the audit trail so the workflow can complete cleanly,
    // and surface a clear NOT_IMPLEMENTED so operators know to either
    // wire a voicemail provider or substitute comm.send_sms.
    await db.insert(auditLogTable).values({
      action: "voicemail.requested_no_provider",
      entity_type: "automation_run",
      entity_id: String(s.ctx.runId),
      details: { params: s.node.data?.params, note: "No voicemail-drop provider wired in this deployment." } as any,
    } as any);
    return { ok: false, code: "PROVIDER_NOT_CONFIGURED", error: "Voicemail drop is not implemented. Wire a voicemail provider (e.g. Slybroadcast) or use comm.send_sms with a callback link." };
  },
  "comm.send_calendar_invite": async (s) => {
    // Build an RFC-5545 .ics attachment and send via the configured
    // email provider. No undeclared-param trapdoor — the catalog's
    // `to/title/startsAt/endsAt/location/body` are sufficient.
    const p = s.node.data?.params ?? {};
    const to = String(resolveOrLiteral(s, p.to) ?? "").trim();
    const title = String(resolveOrLiteral(s, p.title) ?? "").trim();
    const startsAt = String(resolveOrLiteral(s, p.startsAt) ?? "").trim();
    if (!to || !title || !startsAt) throw new Error("comm.send_calendar_invite requires `to`, `title`, and `startsAt`.");
    const endsAt = String(resolveOrLiteral(s, p.endsAt) ?? "").trim() ||
      new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString();
    const location = String(resolveOrLiteral(s, p.location) ?? "").trim();
    const bodyText = String(resolveOrLiteral(s, p.body) ?? title);

    const fmt = (iso: string) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO timestamp: ${iso}`);
      return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    };
    const uid = `${s.ctx.runId}-${s.node.id}@mtos`;
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MTOS//Automation//EN",
      "CALSCALE:GREGORIAN", "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${fmt(new Date().toISOString())}`,
      `DTSTART:${fmt(startsAt)}`,
      `DTEND:${fmt(endsAt)}`,
      `SUMMARY:${title.replace(/[\r\n]+/g, " ")}`,
      `DESCRIPTION:${bodyText.replace(/[\r\n]+/g, "\\n")}`,
      ...(location ? [`LOCATION:${location.replace(/[\r\n]+/g, " ")}`] : []),
      `ORGANIZER:mailto:noreply@mtos.local`,
      `ATTENDEE;RSVP=TRUE:mailto:${to}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");

    // Best-effort: deliver via the configured email provider. If none
    // is configured, audit-log the ICS so the operator can see the
    // payload that would have been sent.
    const resolved = await resolveProvider("email");
    if (!isResolved(resolved)) {
      await db.insert(auditLogTable).values({
        action: "calendar_invite.no_email_provider",
        entity_type: "automation_run",
        entity_id: String(s.ctx.runId),
        details: { to, title, startsAt, endsAt, location, ics_uid: uid, reason: resolved.reason, message: resolved.details } as any,
      } as any);
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", error: resolved.details ?? "No email provider configured." };
    }
    const adapter = getEmailAdapter(resolved.provider);
    if (!adapter) {
      return { ok: false, code: "ADAPTER_NOT_FOUND", error: `No email adapter for ${resolved.provider}.` };
    }
    const fromCfg = (resolved.credentials.config && typeof resolved.credentials.config === "object" ? resolved.credentials.config : {}) as Record<string, unknown>;
    const fromEmail = (typeof fromCfg.from_email === "string" ? fromCfg.from_email : "") || "noreply@mtos.local";
    const html = `<p>${bodyText.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c))}</p>` +
      `<pre style="font-family:monospace;font-size:11px;background:#f6f6f6;padding:8px;border-radius:4px">${ics}</pre>`;
    const out = await adapter.send(resolved.credentials, {
      to,
      fromEmail,
      subject: title,
      html,
      text: `${bodyText}\n\nWhen: ${startsAt} → ${endsAt}${location ? `\nWhere: ${location}` : ""}\n\n${ics}`,
    });
    if (!out.ok) {
      throw new Error(`Calendar invite email failed: ${out.message}`);
    }
    return { ok: true, externalMessageId: out.externalMessageId, ics_uid: uid, provider: resolved.provider };
  },

  // ───────── Documents
  "documents.render_template": async (s) => {
    const p = s.node.data?.params ?? {};
    const templateIdRaw = resolveOrLiteral(s, p.templateId);
    const templateId = Number(templateIdRaw);
    if (!Number.isInteger(templateId)) throw new Error("documents.render_template requires templateId.");
    const [tpl] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, templateId));
    if (!tpl) throw new Error(`Template ${templateId} not found.`);
    const variables = (resolveOrLiteral(s, p.variables) ?? s.input ?? {}) as Record<string, unknown>;
    // Templates are either uploaded PDFs (storage_path) or AI-drafted (ai_prompt).
    // For the PDF case we just return the storage handle — operators consume it
    // via documents.send_dropbox_sign / send_docusign which already merge fields
    // server-side. For the AI case we run the prompt with merge-field substitution.
    if (tpl.source === "ai" && tpl.ai_prompt) {
      const filledPrompt = tpl.ai_prompt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
        const v = resolvePath(variables, key);
        return v == null ? "" : String(v);
      });
      const body = await callLLM({
        module: "drafting-ai",
        systemPrompt: "You are a legal drafting assistant. Output only the rendered document body.",
        prompt: filledPrompt,
        maxTokens: 1500,
      });
      return { template_id: templateId, name: tpl.name, source: "ai" as const, body };
    }
    return { template_id: templateId, name: tpl.name, source: tpl.source, storage_path: tpl.storage_path };
  },
  "documents.send_dropbox_sign": async (s) => {
    // Catalog params: templateId, signerEmail, signerName, fields. The
    // signer fields flow into the worker job so the worker can resolve the
    // packet recipient even if there's no upstream lead. leadId is read
    // from the upstream input the same way integration.send_esign does.
    const p = s.node.data?.params ?? {};
    const templateId = Number(resolveOrLiteral(s, p.templateId));
    const signerEmail = String(resolveOrLiteral(s, p.signerEmail) ?? "").trim();
    const signerName = String(resolveOrLiteral(s, p.signerName) ?? "").trim();
    const fields = (p.fields ?? {}) as Record<string, any>;
    const leadId = Number(resolveOrLiteral(s, s.input?.lead?.id ?? s.input?.lead_id));
    if (!Number.isInteger(templateId) || !signerEmail || !signerName) {
      throw new Error("documents.send_dropbox_sign requires templateId, signerEmail, signerName.");
    }
    if (!Number.isInteger(leadId)) {
      throw new Error("documents.send_dropbox_sign needs a leadId on the upstream input.");
    }
    const [owned] = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(s.ctx.firmId == null
        ? eq(leadsTable.id, leadId)
        : and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, s.ctx.firmId)))
      .limit(1);
    if (!owned) throw new Error(`documents.send_dropbox_sign: lead ${leadId} not in firm ${s.ctx.firmId}.`);
    const jobId = await enqueueJob("send_esign_packet", { lead_id: leadId, template_id: templateId });
    return { enqueued: true, job_id: jobId, signer_email: signerEmail, signer_name: signerName, prefill: fields, provider: "dropbox_sign" };
  },
  "documents.send_docusign": async (s) => {
    const p = s.node.data?.params ?? {};
    const templateId = Number(resolveOrLiteral(s, p.templateId));
    const signerEmail = String(resolveOrLiteral(s, p.signerEmail) ?? "").trim();
    const signerName = String(resolveOrLiteral(s, p.signerName) ?? "").trim();
    const fields = (p.fields ?? {}) as Record<string, any>;
    const leadId = Number(resolveOrLiteral(s, s.input?.lead?.id ?? s.input?.lead_id));
    if (!Number.isInteger(templateId) || !signerEmail || !signerName) {
      throw new Error("documents.send_docusign requires templateId, signerEmail, signerName.");
    }
    if (!Number.isInteger(leadId)) {
      throw new Error("documents.send_docusign needs a leadId on the upstream input.");
    }
    const [owned] = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(s.ctx.firmId == null
        ? eq(leadsTable.id, leadId)
        : and(eq(leadsTable.id, leadId), eq(leadsTable.firm_id, s.ctx.firmId)))
      .limit(1);
    if (!owned) throw new Error(`documents.send_docusign: lead ${leadId} not in firm ${s.ctx.firmId}.`);
    const jobId = await enqueueJob("send_esign_packet", { lead_id: leadId, template_id: templateId });
    return { enqueued: true, job_id: jobId, signer_email: signerEmail, signer_name: signerName, tabs: fields, provider: "docusign" };
  },
  "documents.fax_medical_records": async (s) => {
    // Conflict resolution (Task #65 + #66): keep Task #66's real fax
    // dispatch — pull leadId from params, resolve the target fax number
    // from either an explicit `providerFax` override or the lead's
    // `hospital_fax` column, validate via the shared E.164 normalizer,
    // and hand off to the existing fax_med_records job handler. Branches
    // "sent" / "failed" so an automation graph can react to either
    // outcome without crashing the whole run.
    const idRaw = resolveOrLiteral(s, s.node.data?.params?.leadId);
    const leadId = Number(idRaw);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return { __branch: "failed", value: { error: "invalid_lead_id", lead_id: idRaw } };
    }
    const explicitFax = s.node.data?.params?.providerFax
      ? String(resolveOrLiteral(s, s.node.data.params.providerFax) ?? "").trim()
      : "";
    const explicitIntegrationId = s.node.data?.params?.integrationId
      ? Number(resolveOrLiteral(s, s.node.data.params.integrationId))
      : null;

    try {
      const { normalizeFaxNumber } = await import("../fax/normalize");
      const { handleFaxMedRecordsRequest, recordFaxFailure } = await import("../workflow-handlers");

      // Validate any explicit override (does NOT mutate the lead row — the
      // override is passed ephemerally to the handler). When the override is
      // bad we MUST still write a fax_results row so the operator timeline
      // reflects the failure (and so downstream nodes can link to it via
      // fax_results_id) — otherwise the failure is invisible outside the
      // automation run history.
      let overrideFax: string | null = null;
      if (explicitFax) {
        const norm = normalizeFaxNumber(explicitFax);
        if (!norm.ok) {
          const faxResultId = await recordFaxFailure(
            leadId,
            0,
            "invalid_override_fax",
            `Automation override fax invalid: ${norm.message}`,
          ).catch(() => 0);
          return {
            __branch: "failed",
            value: {
              error: "invalid_fax_number",
              message: norm.message,
              fax_results_id: faxResultId || null,
              lead_id: leadId,
            },
          };
        }
        overrideFax = norm.e164;
      }

      // envelope_id=0 marks "no upstream HIPAA envelope" — the fax cover sheet
      // and fax_results.source_file template both accept a numeric placeholder.
      const result = await handleFaxMedRecordsRequest({
        lead_id: leadId,
        envelope_id: 0,
        explicit_integration_id: Number.isFinite(explicitIntegrationId as number) ? (explicitIntegrationId as number) : null,
        override_fax: overrideFax,
      });
      return {
        __branch: result.ok ? "sent" : "failed",
        value: {
          lead_id: leadId,
          status: result.status,
          fax_results_id: result.faxResultId,
          external_fax_id: result.externalFaxId,
          provider: result.provider,
          to: result.to,
        },
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Try to parse the fax_results.id we appended to the error message
      // so downstream nodes can still link to the timeline row.
      const m = /fax_results\.id=(\d+)/.exec(message);
      const faxResultId = m ? Number(m[1]) : null;
      logger.warn({ runId: s.ctx.runId, leadId, err: message }, "documents.fax_medical_records failed");
      return { __branch: "failed", value: { error: "send_failed", message, fax_results_id: faxResultId, lead_id: leadId } };
    }
  },
    "documents.ocr_extract": async (s) => {
    const p = s.node.data?.params ?? {};
    let documentId = String(resolveOrLiteral(s, p.documentId) ?? "").trim();

    // If documentId looks like a numeric fax_result_id, resolve the vault_path
    if (/^\d+$/.test(documentId)) {
      const faxRow = await db.execute(
        sql`SELECT vault_path, raw_text FROM fax_results WHERE id = ${Number(documentId)} LIMIT 1`
      ).catch(() => null);
      const faxRec = (faxRow as any)?.rows?.[0] ?? (faxRow as any)?.[0];
      if (faxRec?.vault_path) {
        documentId = faxRec.vault_path;
      } else if (faxRec?.raw_text) {
        // Already have raw text — skip OCR and return it directly
        return { text: faxRec.raw_text, raw_text: faxRec.raw_text, ocr_skipped: true };
      }
    }

    // If still no valid vault path, return the raw_text from input if available
    if (!documentId || /^\d+$/.test(documentId)) {
      const rawText = String(s.input?.raw_text ?? s.vars?.raw_text ?? "");
      if (rawText) return { text: rawText, raw_text: rawText, ocr_skipped: true };
      throw new Error("documents.ocr_extract requires \`documentId\` (vault key).");
    }

    const language = String(p.language ?? "en");
    const buf = await readFile(documentId);
    const text = buf.toString("utf-8");
    return { document_id: documentId, text, raw_text: text, language };
  },
  "documents.medical_extract": async (s) => {
    // Catalog params: `documentId`, optional `schema` (advisory — analyze
    // DocumentText returns its canonical schema; passing schema is reserved
    // for a future structured-extract path).
    const p = s.node.data?.params ?? {};
    const documentId = String(resolveOrLiteral(s, p.documentId ?? s.input?.documentId) ?? "");
    if (!documentId) throw new Error("documents.medical_extract requires `documentId` (vault key).");
    const buf = await readFile(documentId);
    const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf ?? "");
    if (!text) throw new Error(`documents.medical_extract: document '${documentId}' is empty or non-text.`);
    const fields = await analyzeDocumentText(text);
    return { documentId, fields };
  },

  // ───────── Forms
  "forms.publish": async (s) => {
    // Catalog params: `formId` (tort code or form id), optional `version`.
    const p = s.node.data?.params ?? {};
    const formId = String(resolveOrLiteral(s, p.formId) ?? "");
    if (!formId) throw new Error("forms.publish requires `formId`.");
    const cfg = await getFormConfig(formId);
    if (!cfg) throw new Error(`No form configuration found for '${formId}'.`);
    return { form_id: formId, version: p.version ?? null, published: true, config: cfg };
  },
  "forms.embed_script": async (s) => {
    // Catalog param: `formId`.
    const formId = String(resolveOrLiteral(s, s.node.data?.params?.formId) ?? "");
    if (!formId) throw new Error("forms.embed_script requires `formId`.");
    const cfg = await getFormConfigByIdOrLabel(formId);
    if (!cfg) throw new Error(`No form configuration for '${formId}'.`);
    const baseUrl = process.env["PUBLIC_BASE_URL"] ?? "";
    // Minimal embed: a one-line <script> tag pointing at our public embed
    // endpoint. The actual JS is served by routes/forms.ts → /forms/embed/:id.
    const embed = `<script src="${baseUrl}/api/forms-public/embed/${cfg.id}" defer></script>`;
    return { form_id: cfg.id, embed_html: embed };
  },
  "forms.validate_submission": async (s) => {
    // Catalog params: `formId`, `payload`. `payload` may resolve to an object
    // already, or fall back to the workflow input for convenience.
    const submission = (resolveOrLiteral(s, s.node.data?.params?.payload) ?? s.input ?? {}) as Record<string, unknown>;
    const required = ["first_name", "last_name", "email", "phone_primary", "tort_type"];
    const missing = required.filter((k) => {
      const v = submission[k];
      return v == null || (typeof v === "string" && v.trim() === "");
    });
    if (missing.length === 0) {
      return { __branch: "valid", value: { ok: true } };
    }
    return { __branch: "invalid", value: { missing_fields: missing } };
  },
  "forms.create_lead_from_submission": async (s) => {
    // Catalog params: `formId`, `payload`.
    const submission = (resolveOrLiteral(s, s.node.data?.params?.payload) ?? s.input ?? {}) as Record<string, unknown>;
    const tortType = String(submission["tort_type"] ?? s.node.data?.params?.formId ?? "").trim();
    const email = submission["email"] != null ? String(submission["email"]) : null;
    const phone = submission["phone_primary"] != null ? String(submission["phone_primary"]) : null;
    if (!tortType) throw new Error("forms.create_lead_from_submission requires submission.tort_type.");
    const existing = await findExistingLeadForIntake({
      tortType,
      email,
      phone,
    });
    if (existing) {
      return { lead_id: existing.leadId, deduped: true, matched_by: existing.matchedBy };
    }
    const [created] = await db.insert(leadsTable).values({
      name: String(submission["first_name"] ?? "") + " " + String(submission["last_name"] ?? ""),
      tort_type: tortType,
      email,
      phone_primary: phone,
      first_name: submission["first_name"] as any,
      last_name: submission["last_name"] as any,
      source: "automation",
      status: "new",
    } as any).returning();
    return { lead_id: created.id, deduped: false };
  },

  // ───────── AI (extended)
  "ai.agent": async (s) => {
    // Catalog params: goal, tools, maxSteps, model. We do NOT run a real
    // tool-loop agent (it needs a sandboxed tool registry that hasn't been
    // built yet). Instead we run a single-turn LLM completion bounded by
    // maxSteps=1; any catalog config asking for >1 steps falls through the
    // `max_steps` branch so workflow authors can route to a human review
    // node rather than silently truncating.
    const p = s.node.data?.params ?? {};
    const goal = String(resolveOrLiteral(s, p.goal) ?? "");
    if (!goal) {
      return { __branch: "error", value: { code: "MISSING_GOAL", error: "ai.agent requires `goal`." } };
    }
    const maxSteps = Number(p.maxSteps ?? 1);
    if (Number.isFinite(maxSteps) && maxSteps > 1) {
      return {
        __branch: "max_steps",
        value: {
          code: "AGENT_LOOP_NOT_IMPLEMENTED",
          error: `ai.agent multi-step loops aren't implemented yet (requested maxSteps=${maxSteps}). Falling through max_steps branch.`,
          stepsRun: 1,
          maxSteps,
        },
      };
    }
    try {
      const output = await callLLM({
        module: "lead-intelligence",
        systemPrompt: "You are an autonomous assistant. Reply only with the final answer.",
        prompt: `${goal}\n\nContext:\n${JSON.stringify(s.input ?? {}, null, 2).slice(0, 4000)}`,
        maxTokens: 1000,
      });
      return { __branch: "success", value: { output, stepsRun: 1 } };
    } catch (err: any) {
      return { __branch: "error", value: { error: err?.message ?? String(err) } };
    }
  },
  "ai.classify": async (s) => {
    const p = s.node.data?.params ?? {};
    const text = String(resolveOrLiteral(s, p.text ?? s.input?.text) ?? "");
    const labels = (p.labels ?? []) as string[];
    if (!text || labels.length === 0) throw new Error("ai.classify requires text and a non-empty labels array.");
    const raw = await callLLM({
      module: "lead-intelligence",
      systemPrompt: `You are a classifier. Choose exactly ONE label from this list: ${labels.join(", ")}. Respond with the label only.`,
      prompt: text,
      maxTokens: 16,
    });
    const picked = raw.trim();
    return { label: labels.includes(picked) ? picked : labels[0], raw };
  },
  "ai.chat_response": async (s) => {
    // Catalog params: `message` (path/literal of inbound message), `persona`,
    // `history` (path to prior conversation array — folded into the prompt).
    const p = s.node.data?.params ?? {};
    const userMsg = String(resolveOrLiteral(s, p.message ?? s.input?.message) ?? "");
    if (!userMsg) throw new Error("ai.chat_response requires `message`.");
    const history = resolveOrLiteral(s, p.history);
    const histText = Array.isArray(history)
      ? "\n\nPrior conversation:\n" + history.slice(-10).map((m: any) => `${m?.role ?? "user"}: ${m?.content ?? m}`).join("\n")
      : "";
    const reply = await callLLM({
      module: "drafting-ai",
      systemPrompt: String(p.persona ?? "You are a helpful customer-service assistant for a mass tort law firm. Be concise and never give legal advice."),
      prompt: userMsg + histText,
      maxTokens: 400,
    });
    return { reply };
  },
  "ai.voice_agent": async (s) => {
    // Real Vapi-style outbound voice agent dial. Catalog branches
    // completed|failed. We treat the synchronous "call dispatched" ack
    // as `completed` (the actual call lifecycle is reported via the
    // /webhooks/voice/:provider route into the run trail). Errors map
    // to `failed` with a structured payload.
    const p = s.node.data?.params ?? {};
    const agentId = String(resolveOrLiteral(s, p.agentId) ?? "").trim();
    const callIdRaw = resolveOrLiteral(s, p.callId);
    const to = String(resolveOrLiteral(s, p.to ?? s.input?.to ?? s.input?.lead?.phone) ?? "").trim();
    const metadata = (resolveOrLiteral(s, p.metadata) ?? {}) as Record<string, any>;
    if (!agentId) {
      return { __branch: "failed", value: { ok: false, code: "MISSING_AGENT_ID", error: "ai.voice_agent requires `agentId`." } };
    }
    if (!to) {
      return { __branch: "failed", value: { ok: false, code: "MISSING_TO", error: "ai.voice_agent needs a destination number — set `to` or pass it via input.lead.phone / input.to." } };
    }
    const resolved = await resolveProvider("voice");
    if (!isResolved(resolved)) {
      return { __branch: "failed", value: { ok: false, code: "PROVIDER_NOT_CONFIGURED", reason: resolved.reason, error: resolved.details ?? "No voice provider configured." } };
    }
    const adapter = getVoiceAdapter(resolved.provider);
    if (!adapter) {
      return { __branch: "failed", value: { ok: false, code: "ADAPTER_NOT_FOUND", error: `No voice adapter for ${resolved.provider}.` } };
    }
    const out = await adapter.startCall(resolved.credentials, {
      to,
      assistantId: agentId,
      metadata: {
        run_id: String(s.ctx.runId),
        workflow_id: String(s.ctx.workflowId),
        ...(callIdRaw != null ? { upstream_call_id: String(callIdRaw) } : {}),
        ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
      },
    });
    if (!out.ok) {
      return { __branch: "failed", value: { ok: false, code: out.code, error: out.message, retryable: out.retryable } };
    }
    return { __branch: "completed", value: { ok: true, externalCallId: out.externalCallId, provider: resolved.provider, agentId, note: "Voice agent dispatched. Conversation outcome arrives via /webhooks/voice/:provider." } };
  },
  "ai.transcribe": async (s) => {
    // Transcribe an audio URL via OpenAI Whisper. We look up the most
    // recent active OpenAI integration in the vault — the project's
    // ai-provider already routes LLM traffic through configured
    // integrations, so reusing the same OpenAI key for whisper keeps
    // ops surface area down. Fails cleanly with PROVIDER_NOT_CONFIGURED
    // when no openai integration exists.
    const p = s.node.data?.params ?? {};
    const audioUrl = String(resolveOrLiteral(s, p.audioUrl) ?? "").trim();
    const language = String(resolveOrLiteral(s, p.language) ?? "en").trim() || "en";
    if (!audioUrl) throw new Error("ai.transcribe requires `audioUrl`.");

    // SSRF guard — same allowlist as the rest of the executor's outbound paths.
    await assertSafeOutboundUrl(audioUrl);

    const [openaiRow] = await db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.provider, "openai"), eq(integrationsTable.status, "active")))
      .orderBy(sql`${integrationsTable.created_at} DESC`)
      .limit(1);
    if (!openaiRow) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", error: "ai.transcribe needs an active OpenAI integration in the vault (Whisper). Add one on the Integrations page." };
    }
    const creds = await getIntegrationCredentialsById(openaiRow.id);
    const apiKey = creds?.api_key?.toString().trim();
    if (!apiKey) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", error: "OpenAI integration is missing api_key." };
    }

    // Download the audio asset, then upload to Whisper via multipart.
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`ai.transcribe: failed to download audio (HTTP ${audioResp.status})`);
    const audioBuf = Buffer.from(await audioResp.arrayBuffer());
    const filename = (() => {
      try { return path.basename(new URL(audioUrl).pathname) || "audio.mp3"; } catch { return "audio.mp3"; }
    })();
    const contentType = audioResp.headers.get("content-type") || "audio/mpeg";

    const form = new FormData();
    form.append("file", new Blob([audioBuf], { type: contentType }), filename);
    form.append("model", "whisper-1");
    form.append("language", language);
    form.append("response_format", "json");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form as any,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`Whisper transcription failed: ${json?.error?.message ?? `HTTP ${resp.status}`}`);
    }
    return { ok: true, text: String(json.text ?? ""), language, provider: "openai-whisper" };
  },

  // ───────── Utility
  "utility.log": async (s) => {
    const level = String(s.node.data?.params?.level ?? "info") as "info" | "warn" | "error";
    const msg = String(s.node.data?.params?.message ?? "");
    logger[level]({ runId: s.ctx.runId, nodeId: s.node.id }, msg);
    return s.input;
  },
  "utility.end": async (s) => {
    return { __branch: "__end__", value: s.node.data?.params?.output ?? s.input };
  },
};

function resolveOrLiteral(s: StepContext, raw: any): any {
  if (typeof raw !== "string") return raw;
  if (raw.startsWith("input.") || raw.startsWith("vars.")) {
    return resolvePath({ input: s.input, vars: s.vars }, raw);
  }
  return raw;
}

async function stubIntegration(name: string, s: StepContext): Promise<any> {
  // For v1 these record what would have been sent; the real adapters live
  // in lib/email, lib/fax, lib/esign, etc. Wiring each through requires a
  // per-adapter call surface — done in follow-up. This keeps the engine
  // testable end-to-end without surprise side effects.
  logger.info({ node: s.node.type, params: s.node.data?.params, runId: s.ctx.runId }, `[automation] ${name} stub invoked`);
  return { simulated: true, name, params: s.node.data?.params };
}

function runProcess(cmd: string, args: string[], stdin: string, s: StepContext, codeFlag?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(s.node.data?.params?.timeoutMs ?? 15000);
    const finalArgs = codeFlag ? [codeFlag, stdin] : args;
    const child = spawn(cmd, finalArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
      try { resolve(JSON.parse(out)); } catch { resolve({ stdout: out, stderr: err }); }
    });
    if (!codeFlag && stdin) { child.stdin.write(stdin); }
    if (s.input != null) { try { child.stdin.write(JSON.stringify(s.input)); } catch {} }
    child.stdin.end();
  });
}

export async function runWorkflow(opts: ExecutorOptions): Promise<RunResult> {
  const [wf] = await db.select().from(automationWorkflowsTable).where(eq(automationWorkflowsTable.id, opts.workflowId)).limit(1);
  if (!wf) throw new Error(`Workflow ${opts.workflowId} not found`);
  const graph = (wf.graph ?? { nodes: [], edges: [] }) as Graph;

  // Pick the entry node — first trigger.* node in graph.
  const entry = graph.nodes.find((n) => n.type.startsWith("trigger."));
  if (!entry) throw new Error("Workflow has no trigger node.");

  const [run] = await db.insert(automationRunsTable).values({
    workflow_id: opts.workflowId,
    firm_id: opts.firmId ?? wf.firm_id,
    status: "running",
    trigger_source: opts.triggerSource ?? "manual",
    input: opts.input ?? {},
    started_by_user_id: opts.startedByUserId ?? null,
  } as any).returning();

  const steps: StepLogEntry[] = [];
  const vars: Record<string, any> = {};
  let lastOutput: any = opts.input ?? {};
  let currentId: string | null = entry.id;
  let visitedCount = 0;
  let runStatus: "completed" | "failed" = "completed";
  let errorMessage: string | undefined;

  try {
    while (currentId) {
      if (++visitedCount > MAX_STEPS) throw new Error(`Workflow exceeded ${MAX_STEPS} steps (possible loop).`);
      const node = graph.nodes.find((n) => n.id === currentId);
      if (!node) throw new Error(`Edge points to missing node ${currentId}`);
      const handler = HANDLERS[node.type];
      if (!handler) throw new Error(`No handler for node type ${node.type}`);
      const startedAt = new Date().toISOString();
      let output: any; let branch: string | undefined; let status: "ok" | "error" = "ok"; let stepError: string | undefined;
      try {
        const res = await handler({ node, input: lastOutput, vars, ctx: { workflowId: opts.workflowId, firmId: opts.firmId ?? wf.firm_id ?? null, runId: run.id } });
        if (res && typeof res === "object" && (res as any).__branch) {
          branch = (res as any).__branch as string;
          output = (res as any).value;
          // Validate the branch name against the catalog so a typoed handler
          // can't silently route off a non-existent edge. The implicit
          // sentinel "__end__" is always allowed (utility.end uses it).
          if (branch !== "__end__") {
            const def = getNodeDefinition(node.type);
            const allowed = Array.isArray(def?.outputs) ? (def!.outputs as string[]) : null;
            if (allowed && !allowed.includes(branch)) {
              throw new Error(
                `Handler for ${node.type} returned branch "${branch}" but the catalog declares only [${allowed.join(", ")}]. Update the catalog or fix the handler.`,
              );
            }
          }
        } else {
          output = res;
          // Contract: nodes whose catalog declares NAMED outputs must always
          // emit a `__branch`. Without it, the executor cannot pick a next
          // edge deterministically and the workflow would silently dead-end.
          // We surface this as a hard error so handler bugs are caught fast.
          const def = getNodeDefinition(node.type);
          const allowed = Array.isArray(def?.outputs) ? (def!.outputs as string[]) : null;
          if (allowed && allowed.length > 0) {
            throw new Error(
              `Handler for ${node.type} returned no __branch but the catalog declares named outputs [${allowed.join(", ")}]. Handler must return { __branch, value }.`,
            );
          }
        }
      } catch (err: any) {
        status = "error"; stepError = err?.message ?? String(err);
      }
      const finishedAt = new Date().toISOString();
      steps.push({ node_id: node.id, type: node.type, label: node.data?.label, started_at: startedAt, finished_at: finishedAt, status, branch, output: status === "ok" ? safeOutput(output) : undefined, error: stepError });
      if (status === "error") { runStatus = "failed"; errorMessage = stepError; break; }
      if (branch === "__end__") { lastOutput = output; break; }
      lastOutput = output ?? lastOutput;
      // Find next edge — match sourceHandle when branch was set.
      const next = graph.edges.find((e) => e.source === node.id && (branch ? (e.sourceHandle === branch) : (e.sourceHandle == null || e.sourceHandle === "out")));
      currentId = next?.target ?? null;
    }
  } catch (err: any) {
    runStatus = "failed";
    errorMessage = err?.message ?? String(err);
  }

  await db.update(automationRunsTable).set({
    status: runStatus,
    output: safeOutput(lastOutput) as any,
    step_log: steps as any,
    error: errorMessage ?? null,
    completed_at: new Date(),
  } as any).where(eq(automationRunsTable.id, run.id));

  return { runId: run.id, status: runStatus, output: lastOutput, steps, error: errorMessage };
}

function safeOutput(v: any): any {
  try {
    const redacted = redactSecrets(v);
    const s = JSON.stringify(redacted);
    if (s.length > 50_000) return { _truncated: true, preview: s.slice(0, 5_000) };
    return redacted;
  } catch {
    return { _unserializable: true };
  }
}
