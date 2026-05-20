/**
 * Thin client for the Jules API (https://jules.googleapis.com/v1alpha).
 *
 * Powers the CRM Self-Heal feature: an operator pastes an error message
 * (or a feature request) and we hand it off to Jules, which spins up a
 * coding agent against the configured GitHub source and (by default)
 * auto-opens a PR. Per the AI Constitution, the human still does final
 * review — Jules opens the PR, the operator merges it.
 *
 * Auth: X-Goog-Api-Key header. Source must be installed via the Jules
 * GitHub App ahead of time. Default source is derived from the local
 * git remote at startup; operators can override per-session.
 */
import { logger } from "./logger";

const JULES_BASE = process.env["JULES_API_BASE"] || "https://jules.googleapis.com/v1alpha";
const DEFAULT_TIMEOUT_MS = 20_000;

export class JulesError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "JulesError";
  }
}

export interface JulesSource {
  name: string;
  id: string;
  githubRepo?: { owner: string; repo: string };
}

export interface JulesPullRequest {
  url: string;
  title?: string;
  description?: string;
}

export interface JulesSession {
  name: string;
  id: string;
  title?: string;
  prompt?: string;
  sourceContext?: {
    source: string;
    githubRepoContext?: { startingBranch?: string };
  };
  outputs?: Array<{ pullRequest?: JulesPullRequest }>;
}

export interface JulesActivity {
  name: string;
  id: string;
  createTime?: string;
  originator?: "user" | "agent" | string;
  planGenerated?: { plan?: { id: string; steps?: Array<{ id: string; title: string; index?: number }> } };
  planApproved?: { planId: string };
  progressUpdated?: { title?: string; description?: string };
  artifacts?: unknown[];
}

export type AutomationMode = "AUTO_CREATE_PR" | "MANUAL";

export interface CreateSessionInput {
  prompt: string;
  sourceName: string;
  startingBranch?: string;
  automationMode?: AutomationMode;
  requirePlanApproval?: boolean;
  title?: string;
}

function getApiKey(): string {
  const key = process.env["JULES_API_KEY"];
  if (!key) {
    throw new JulesError(
      "JULES_API_KEY is not configured. Add it in Secrets to enable Self-Heal.",
      503,
    );
  }
  return key;
}

async function julesFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${JULES_BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "X-Goog-Api-Key": getApiKey(),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!res.ok) {
      logger.warn({ url, status: res.status, body }, "jules api error");
      const msg =
        (typeof body === "object" && body && "error" in body && (body as { error?: { message?: string } }).error?.message) ||
        `Jules API ${res.status}`;
      throw new JulesError(msg as string, res.status, body);
    }
    return body as T;
  } catch (err) {
    if (err instanceof JulesError) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new JulesError(`Jules API timeout after ${init.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, 504);
    }
    throw new JulesError(`Jules API network error: ${(err as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function listSources(): Promise<{ sources: JulesSource[]; nextPageToken?: string }> {
  return julesFetch("/sources");
}

export async function createSession(input: CreateSessionInput): Promise<JulesSession> {
  return julesFetch<JulesSession>("/sessions", {
    method: "POST",
    body: {
      prompt: input.prompt,
      sourceContext: {
        source: input.sourceName,
        githubRepoContext: { startingBranch: input.startingBranch ?? "main" },
      },
      automationMode: input.automationMode ?? "AUTO_CREATE_PR",
      requirePlanApproval: input.requirePlanApproval ?? false,
      title: input.title,
    },
  });
}

export async function getSession(sessionId: string): Promise<JulesSession> {
  return julesFetch<JulesSession>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listActivities(
  sessionId: string,
  pageSize = 30,
): Promise<{ activities: JulesActivity[]; nextPageToken?: string }> {
  return julesFetch(`/sessions/${encodeURIComponent(sessionId)}/activities?pageSize=${pageSize}`);
}

export async function sendMessage(sessionId: string, prompt: string): Promise<void> {
  await julesFetch(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
    method: "POST",
    body: { prompt },
  });
}

export async function approvePlan(sessionId: string): Promise<void> {
  await julesFetch(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
    method: "POST",
    body: {},
  });
}

/**
 * Best-effort detection of `sources/github/owner/repo` from the local
 * git remote. Returns null if no github remote is configured. Used as a
 * default for new self-heal sessions; operators can always override.
 */
let cachedSource: string | null | undefined;
export async function getDefaultSourceName(): Promise<string | null> {
  if (cachedSource !== undefined) return cachedSource;
  const fromEnv = process.env["JULES_DEFAULT_SOURCE"];
  if (fromEnv) {
    cachedSource = fromEnv;
    return cachedSource;
  }
  try {
    // Lazy/sync read of .git/config to keep this dependency-free.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const cfg = path.join(dir, ".git", "config");
      if (fs.existsSync(cfg)) {
        const txt = fs.readFileSync(cfg, "utf8");
        const m = txt.match(/url\s*=\s*[^\n]*github\.com[/:]([^/\s]+)\/([^/.\s]+)(?:\.git)?/);
        if (m) {
          cachedSource = `sources/github/${m[1]}/${m[2]}`;
          return cachedSource;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  cachedSource = null;
  return cachedSource;
}

export function isJulesConfigured(): boolean {
  return !!process.env["JULES_API_KEY"];
}
