/**
 * Self-Heal / Auto-Fix
 *
 * Operator pastes an error message, log snippet, or feature request and
 * dispatches it to Jules (Google's autonomous coding agent). Jules
 * analyzes the connected GitHub source, writes a fix, and (by default)
 * opens a PR. The operator merges in GitHub — per the AI Constitution
 * we never auto-merge code.
 *
 * Backed by:
 *   GET  /api/admin/self-heal/config     { configured, default_source }
 *   GET  /api/admin/self-heal            list firm's recent sessions
 *   POST /api/admin/self-heal            dispatch a new session
 *   GET  /api/admin/self-heal/:id        session + live activities
 *   POST /api/admin/self-heal/:id/messages
 *   POST /api/admin/self-heal/:id/approve
 *   POST /api/admin/self-heal/:id/refresh
 *
 * RBAC: every endpoint requires `self_heal:manage` (admin-only).
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Wand2, AlertTriangle, ExternalLink, RefreshCw, Send, CheckCircle2,
  Clock, XCircle, Loader2, GitPullRequest, Sparkles, StopCircle, Trash2,
} from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface SelfHealRow {
  id: number;
  firm_id: number;
  created_by_user_id: number;
  jules_session_id: string | null;
  jules_session_name: string | null;
  source_name: string;
  starting_branch: string;
  title: string;
  prompt: string;
  automation_mode: string;
  require_plan_approval: boolean;
  status: string;
  pr_url: string | null;
  pr_title: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityItem {
  id: string;
  name: string;
  createTime?: string;
  originator?: string;
  planGenerated?: { plan?: { id: string; steps?: Array<{ id: string; title: string }> } };
  planApproved?: { planId: string };
  progressUpdated?: { title?: string; description?: string };
}

interface ConfigState {
  configured: boolean;
  default_source: string | null;
}

const STATUS_STYLE: Record<string, { label: string; cls: string; icon: typeof Clock }> = {
  pending:            { label: "Pending",            cls: "bg-slate-100 text-slate-700",   icon: Clock },
  dispatched:         { label: "Working",            cls: "bg-blue-100 text-blue-700",     icon: Loader2 },
  awaiting_approval:  { label: "Awaiting plan",      cls: "bg-amber-100 text-amber-800",   icon: Clock },
  completed:          { label: "PR opened",          cls: "bg-emerald-100 text-emerald-800", icon: CheckCircle2 },
  failed:             { label: "Failed",             cls: "bg-rose-100 text-rose-700",     icon: XCircle },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <Icon className={`h-3 w-3 ${status === "dispatched" ? "animate-spin" : ""}`} />
      {s.label}
    </span>
  );
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SelfHealPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [rows, setRows] = useState<SelfHealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  // Composer state
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState("main");
  const [requireApproval, setRequireApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Drawer state
  const [openId, setOpenId] = useState<number | null>(null);
  const [openRow, setOpenRow] = useState<SelfHealRow | null>(null);
  const [openActivities, setOpenActivities] = useState<ActivityItem[]>([]);
  const [openLoading, setOpenLoading] = useState(false);
  const [followUp, setFollowUp] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const cfgRes = await apiFetchRaw("/api/admin/self-heal/config");
      if (cfgRes.status === 403) { setForbidden(true); return; }
      if (cfgRes.ok) setConfig(await cfgRes.json());

      const listRes = await apiFetchRaw("/api/admin/self-heal");
      if (listRes.ok) {
        const j = await listRes.json();
        setRows(j.sessions ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  // Cancel a session that's still running. Best-effort against Jules; the
  // server flips local status to "cancelled" regardless so the UI never
  // gets stuck on a "Working…" row that Jules has stopped reporting on.
  async function cancelSession(id: number) {
    const res = await apiFetchRaw(`/api/admin/self-heal/${id}/cancel`, { method: "POST" });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      toast({
        title: "Session cancelled",
        description: j?.jules_cancelled
          ? "Stopped Jules and marked local row cancelled."
          : j?.jules_error
            ? `Local row cancelled; Jules cancel failed: ${j.jules_error}`
            : "Marked local row cancelled.",
      });
      void loadAll();
    } else {
      const j = await res.json().catch(() => ({}));
      toast({ title: "Cancel failed", description: j.message || res.statusText, variant: "destructive" });
    }
  }

  // Hard-delete the local row. Server refuses with 409 if the session is
  // still in-flight — the operator has to cancel first so we don't
  // accidentally orphan an active PR-writing session.
  async function deleteSession(id: number) {
    if (!window.confirm("Delete this session from your history? This cannot be undone.")) return;
    const res = await apiFetchRaw(`/api/admin/self-heal/${id}`, { method: "DELETE" });
    if (res.status === 204) {
      toast({ title: "Session deleted" });
      if (openId === id) setOpenId(null);
      void loadAll();
    } else if (res.status === 409) {
      toast({
        title: "Cancel first",
        description: "This session is still running. Click Stop, then Delete.",
        variant: "destructive",
      });
    } else {
      const j = await res.json().catch(() => ({}));
      toast({ title: "Delete failed", description: j.message || res.statusText, variant: "destructive" });
    }
  }

  const IN_FLIGHT_STATUSES = new Set(["pending", "awaiting_approval", "dispatched", "working"]);

  // Soft polling every 12s while any row is in-flight, and while the drawer
  // is open. Pauses if the tab is hidden.
  useEffect(() => {
    const inFlight = rows.some((r) => r.status === "pending" || r.status === "dispatched" || r.status === "awaiting_approval");
    if (!inFlight && openId === null) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadAll();
        if (openId !== null) void openDrawer(openId, true);
      }
    }, 12_000);
    return () => clearInterval(t);
  }, [rows, openId]);

  async function dispatch() {
    if (!prompt.trim() || prompt.trim().length < 10) {
      toast({ title: "Add a longer message", description: "At least 10 characters.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetchRaw("/api/admin/self-heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          starting_branch: branch.trim() || "main",
          require_plan_approval: requireApproval,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: "Dispatch failed",
          description: body?.message ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Dispatched to Jules", description: "It will analyze the repo and open a PR." });
      setPrompt(""); setTitle("");
      void loadAll();
    } finally {
      setSubmitting(false);
    }
  }

  async function openDrawer(id: number, silent = false) {
    if (!silent) { setOpenId(id); setOpenLoading(true); setOpenActivities([]); }
    try {
      const res = await apiFetchRaw(`/api/admin/self-heal/${id}`);
      if (!res.ok) return;
      const j = await res.json();
      setOpenRow(j.session);
      setOpenActivities(j.activities ?? []);
    } finally {
      if (!silent) setOpenLoading(false);
    }
  }

  async function refreshOne(id: number) {
    const res = await apiFetchRaw(`/api/admin/self-heal/${id}/refresh`, { method: "POST" });
    if (res.ok) { void loadAll(); if (openId === id) void openDrawer(id, true); }
  }

  async function sendFollowUp() {
    if (!openId || !followUp.trim()) return;
    const res = await apiFetchRaw(`/api/admin/self-heal/${openId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: followUp.trim() }),
    });
    if (res.ok) {
      setFollowUp("");
      toast({ title: "Message sent" });
      void openDrawer(openId, true);
    } else {
      toast({ title: "Send failed", variant: "destructive" });
    }
  }

  async function approvePlan() {
    if (!openId) return;
    const res = await apiFetchRaw(`/api/admin/self-heal/${openId}/approve`, { method: "POST" });
    if (res.ok) {
      toast({ title: "Plan approved" });
      void loadAll(); void openDrawer(openId, true);
    } else {
      toast({ title: "Approve failed", variant: "destructive" });
    }
  }

  const samplePrompts = useMemo(() => [
    "Fix the audit query column mismatch in artifacts/api-server/src/scripts/n8n-smoke-check.ts — it references requested_at/path but the schema is occurred_at/route. Use the right names.",
    "TypeError: Cannot read properties of undefined (reading 'firm_id') at routes/leads.ts:142 — add a null guard and return 401 if req.user is missing.",
    "Add a 'Copy as cURL' button next to every endpoint in pages/n8n-setup.tsx that copies a ready-to-paste curl command with a placeholder Bearer token.",
  ], []);

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl">
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          You don't have permission to use Self-Heal. Ask an admin to grant you the <code>self_heal:manage</code> permission.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-violet-500" /> Self-Heal / Auto-Fix
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Paste an error, a stack trace, a log snippet, or a feature request. We'll dispatch it
            to Jules (Google's autonomous coding agent). Jules reads the repo, writes the fix, and
            opens a pull request for you to review and merge.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadAll()} data-testid="button-refresh-all">
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {!loading && config && !config.configured && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-amber-900">JULES_API_KEY is not set.</div>
              <div className="text-amber-800 mt-1">
                Add it as an env var on the api-server (Railway → api-server → Variables → JULES_API_KEY). Get a key at{" "}
                <a className="underline" href="https://jules.google.com/settings#api" target="_blank" rel="noopener noreferrer">
                  jules.google.com/settings#api
                </a>{" "}and install the Jules GitHub App on your repo.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && config && config.configured && !config.default_source && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 text-sm">
            No default source detected. Set <code>JULES_DEFAULT_SOURCE</code> to e.g.{" "}
            <code>sources/github/owner/repo</code>, or pass <code>source_name</code> per request.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wand2 className="h-4 w-4" /> New Auto-Fix
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="prompt">What's broken? (or what should we build?)</Label>
            <Textarea
              id="prompt"
              data-testid="input-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Paste an error message, stack trace, log line, or describe the change you want…"
              className="mt-1 font-mono text-sm min-h-[160px]"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {samplePrompts.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => setPrompt(p)}
                >
                  Try sample {i + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="title">Title (optional)</Label>
              <Input
                id="title"
                data-testid="input-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to the first line of the prompt"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="branch">Starting branch</Label>
              <Input
                id="branch"
                data-testid="input-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="approve"
              checked={requireApproval}
              onCheckedChange={(v) => setRequireApproval(!!v)}
              data-testid="checkbox-require-approval"
            />
            <Label htmlFor="approve" className="text-sm font-normal cursor-pointer">
              Require my approval of the plan before Jules writes code
            </Label>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={dispatch}
              disabled={submitting || !config?.configured}
              data-testid="button-auto-fix"
              className="bg-violet-600 hover:bg-violet-700"
            >
              {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}
              Auto-Fix
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No sessions yet. Paste something above to get started.</div>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between border rounded-md px-3 py-2 hover:bg-muted/50 cursor-pointer"
                  onClick={() => openDrawer(r.id)}
                  data-testid={`row-session-${r.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StatusPill status={r.status} />
                      <span className="font-medium text-sm truncate">{r.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {relTime(r.created_at)} · {r.source_name} · {r.starting_branch}
                      {r.last_error && <span className="text-rose-600"> · {r.last_error.slice(0, 80)}</span>}
                    </div>
                  </div>
                  <div className="ml-3 flex items-center gap-1 shrink-0">
                    {r.pr_url && (
                      <a
                        href={r.pr_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs text-violet-700 hover:underline mr-1"
                      >
                        <GitPullRequest className="h-3 w-3" /> PR
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {IN_FLIGHT_STATUSES.has(r.status) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Stop this Jules session"
                        onClick={(e) => { e.stopPropagation(); void cancelSession(r.id); }}
                        data-testid={`button-stop-${r.id}`}
                        className="h-7 px-2"
                      >
                        <StopCircle className="h-3.5 w-3.5 text-amber-600" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      title={IN_FLIGHT_STATUSES.has(r.status)
                        ? "Stop the session before deleting"
                        : "Delete from history"}
                      onClick={(e) => { e.stopPropagation(); void deleteSession(r.id); }}
                      data-testid={`button-delete-${r.id}`}
                      className="h-7 px-2"
                      disabled={IN_FLIGHT_STATUSES.has(r.status)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {openRow && <StatusPill status={openRow.status} />}
              {openRow?.title ?? "Session"}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {openRow?.jules_session_id && <>Jules session <code>{openRow.jules_session_id}</code></>}
            </SheetDescription>
          </SheetHeader>

          {openLoading && <div className="mt-6 text-sm text-muted-foreground">Loading…</div>}

          {openRow && !openLoading && (
            <div className="space-y-4 mt-6">
              {openRow.pr_url && (
                <a
                  href={openRow.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 p-3 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 hover:bg-emerald-100"
                >
                  <GitPullRequest className="h-4 w-4" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{openRow.pr_title || "View pull request"}</div>
                    <div className="text-xs truncate">{openRow.pr_url}</div>
                  </div>
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                <div>Source: <code>{openRow.source_name}</code></div>
                <div>Branch: <code>{openRow.starting_branch}</code></div>
                <div>Mode: <code>{openRow.automation_mode}</code></div>
                <div>Created: {relTime(openRow.created_at)} · Synced: {relTime(openRow.last_synced_at)}</div>
              </div>

              <div>
                <Label className="text-xs">Original prompt</Label>
                <pre className="mt-1 text-xs bg-muted p-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap">{openRow.prompt}</pre>
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => refreshOne(openRow.id)}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Refresh from Jules
                </Button>
                {openRow.status === "awaiting_approval" && (
                  <Button size="sm" onClick={approvePlan} className="bg-emerald-600 hover:bg-emerald-700">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Approve plan
                  </Button>
                )}
              </div>

              <div>
                <Label className="text-xs">Activity</Label>
                <div className="mt-1 space-y-2 max-h-80 overflow-y-auto border rounded p-2">
                  {openActivities.length === 0 && (
                    <div className="text-xs text-muted-foreground">No activity yet.</div>
                  )}
                  {openActivities.map((a) => (
                    <div key={a.id} className="text-xs border-l-2 border-muted-foreground/30 pl-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{a.originator ?? "?"}</Badge>
                        <span className="text-muted-foreground">{relTime(a.createTime)}</span>
                      </div>
                      {a.planGenerated && (
                        <div className="mt-1">
                          <div className="font-medium">Plan:</div>
                          <ol className="list-decimal ml-4">
                            {a.planGenerated.plan?.steps?.map((s) => <li key={s.id}>{s.title}</li>)}
                          </ol>
                        </div>
                      )}
                      {a.planApproved && <div className="mt-1 italic">Plan approved.</div>}
                      {a.progressUpdated && (
                        <div className="mt-1">
                          <div className="font-medium">{a.progressUpdated.title}</div>
                          {a.progressUpdated.description && (
                            <pre className="whitespace-pre-wrap text-[11px] mt-0.5 text-muted-foreground">{a.progressUpdated.description}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="followup" className="text-xs">Send a follow-up message</Label>
                <Textarea
                  id="followup"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  placeholder='e.g. "Can you also add a unit test for that fix?"'
                  className="text-sm"
                  rows={3}
                />
                <Button size="sm" onClick={sendFollowUp} disabled={!followUp.trim()}>
                  <Send className="h-3 w-3 mr-1" /> Send
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
