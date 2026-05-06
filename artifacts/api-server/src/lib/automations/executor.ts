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
import { db, automationRunsTable, automationWorkflowsTable, leadsTable, casesTable, auditLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import vm from "node:vm";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

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
  // Strip leading "input." / "vars." — the caller supplies bindings.
  const parts = path
    .replace(/^input\./, "")
    .replace(/^vars\./, "")
    .split(/[.[\]]/)
    .filter(Boolean);
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
    const value = s.node.data?.params?.value;
    if (name) s.vars[name] = value;
    return s.input;
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
    const [row] = await db.update(leadsTable).set({ ...patch, updated_at: new Date() }).where(eq(leadsTable.id, leadId)).returning();
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
    const data = (s.node.data?.params?.data ?? {}) as Record<string, any>;
    const id = data.id ?? crypto.randomUUID();
    const [row] = await db.insert(casesTable).values({ id, ...data } as any).returning();
    return { case: row };
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
  "integration.send_email": async (s) => stubIntegration("send_email", s),
  "integration.send_fax": async (s) => stubIntegration("send_fax", s),
  "integration.send_esign": async (s) => stubIntegration("send_esign", s),
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
  "ai.extract_fields": async (s) => stubIntegration("ai_extract_fields", s),
  "ai.summarize": async (s) => stubIntegration("ai_summarize", s),
  "ai.draft": async (s) => stubIntegration("ai_draft", s),

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
    const params = (s.node.data?.params?.params ?? []) as any[];
    const result = await db.execute(sql.raw(queryText.replace(/\$(\d+)/g, (_, i) => {
      const v = params[Number(i) - 1];
      if (v == null) return "NULL";
      if (typeof v === "number") return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    })));
    return { rows: (result as any).rows ?? result };
  },
  "io.read_file": async (s) => stubIntegration("read_file", s),
  "io.write_file": async (s) => stubIntegration("write_file", s),

  // ───────── CRM (extended)
  "crm.assign_paralegal": async (s) => stubIntegration("assign_paralegal", s),
  "crm.set_lead_status": async (s) => {
    const idRaw = resolveOrLiteral(s, s.node.data?.params?.leadId);
    const leadId = Number(idRaw);
    const status = String(s.node.data?.params?.status ?? "");
    if (!leadId || !status) throw new Error("crm.set_lead_status requires leadId and status");
    const [row] = await db.update(leadsTable)
      .set({ qualification_status: status, updated_at: new Date() } as any)
      .where(eq(leadsTable.id, leadId)).returning();
    return { lead: row };
  },
  "crm.send_to_review_queue": async (s) => stubIntegration("send_to_review_queue", s),
  "crm.background_check": async (s) => {
    const out = await stubIntegration("background_check", s);
    return { __branch: "clear", value: out };
  },
  "crm.npi_lookup": async (s) => stubIntegration("npi_lookup", s),
  "crm.decision_engine": async (s) => {
    const out = await stubIntegration("decision_engine", s);
    return { __branch: "review", value: out };
  },
  "crm.create_calendar_event": async (s) => stubIntegration("create_calendar_event", s),

  // ───────── Communication
  "comm.send_sms": async (s) => stubIntegration("send_sms", s),
  "comm.send_mms": async (s) => stubIntegration("send_mms", s),
  "comm.make_call": async (s) => {
    const out = await stubIntegration("make_call", s);
    return { __branch: "answered", value: out };
  },
  "comm.send_voicemail": async (s) => stubIntegration("send_voicemail", s),
  "comm.send_calendar_invite": async (s) => stubIntegration("send_calendar_invite", s),

  // ───────── Documents
  "documents.render_template": async (s) => stubIntegration("render_template", s),
  "documents.send_dropbox_sign": async (s) => stubIntegration("send_dropbox_sign", s),
  "documents.send_docusign": async (s) => stubIntegration("send_docusign", s),
  "documents.fax_medical_records": async (s) => {
    // Real wiring: pull leadId from params (literal or `input./vars.` path),
    // resolve the target fax number from either an explicit `providerFax`
    // override or the lead's `hospital_fax` column, validate via the shared
    // E.164 normalizer, and hand off to the existing fax_med_records job
    // handler — which builds the cover sheet, writes a fax_results row, and
    // dispatches via the firm's resolved fax provider (SRFax). Branches
    // "sent" / "failed" so an automation graph can react to either outcome
    // without crashing the whole run.
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
  "documents.ocr_extract": async (s) => stubIntegration("ocr_extract", s),
  "documents.medical_extract": async (s) => stubIntegration("medical_extract", s),

  // ───────── Forms
  "forms.publish": async (s) => stubIntegration("forms_publish", s),
  "forms.embed_script": async (s) => stubIntegration("forms_embed_script", s),
  "forms.validate_submission": async (s) => {
    const out = await stubIntegration("forms_validate_submission", s);
    return { __branch: "valid", value: out };
  },
  "forms.create_lead_from_submission": async (s) => stubIntegration("forms_create_lead_from_submission", s),

  // ───────── AI (extended)
  "ai.agent": async (s) => {
    const out = await stubIntegration("ai_agent", s);
    return { __branch: "success", value: out };
  },
  "ai.classify": async (s) => stubIntegration("ai_classify", s),
  "ai.chat_response": async (s) => stubIntegration("ai_chat_response", s),
  "ai.voice_agent": async (s) => {
    const out = await stubIntegration("ai_voice_agent", s);
    return { __branch: "completed", value: out };
  },
  "ai.transcribe": async (s) => stubIntegration("ai_transcribe", s),

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
        } else {
          output = res;
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
