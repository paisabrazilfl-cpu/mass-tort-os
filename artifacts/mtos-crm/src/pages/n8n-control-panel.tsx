/**
 * n8n Control Panel (OUTBOUND: CRM → n8n)
 *
 * Owner-only operator surface for the global n8n instance the platform owner
 * connected via the env vars N8N_MCP_URL + N8N_MCP_TOKEN. It drives the
 * server-side control plane that already exists:
 *   - GET  /api/automations/n8n/status              — probe the connection
 *   - GET  /api/automations/n8n/workflows?query=&limit=  — list/search workflows
 *   - POST /api/automations/n8n/execute             — run a workflow by id
 *
 * All three routes are gated `requireRole("super_admin")` server-side, so this
 * page is owner-only too. NOTE: this panel speaks to the OWNER'S GLOBAL n8n
 * instance. Per-firm automations (the "Run n8n Workflow" node inside a firm
 * workflow) use each firm's OWN n8n connection from Integrations and never
 * touch this global instance — that isolation lives in the executor, not here.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { apiFetchRaw } from "@/lib/api-fetch";
import {
  Workflow,
  Plug,
  RefreshCw,
  Play,
  Search,
  Copy,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";

interface StatusResult {
  configured: boolean;
  ok: boolean;
  message?: string;
  serverInfo?: { name?: string; version?: string } | null;
  toolCount?: number | null;
  error?: string;
}

interface WfRow {
  id: string;
  name: string;
  active?: boolean;
}

/** Best-effort: pull a list of {id,name} out of whatever the MCP tool returned. */
function coerceWorkflows(raw: unknown): { rows: WfRow[]; rawText: string | null } {
  if (raw == null) return { rows: [], rawText: null };
  // n8n MCP often returns { workflows: [...] } or a bare array of objects.
  let list: any[] | null = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.workflows)) list = obj.workflows as any[];
    else if (Array.isArray(obj.data)) list = obj.data as any[];
    else if (Array.isArray(obj.results)) list = obj.results as any[];
  }
  if (list) {
    const rows: WfRow[] = list
      .map((w): WfRow | null => {
        if (!w || typeof w !== "object") return null;
        const id = String((w as any).id ?? (w as any).workflowId ?? "").trim();
        if (!id) return null;
        const name = String((w as any).name ?? (w as any).title ?? `Workflow ${id}`);
        const active = typeof (w as any).active === "boolean" ? (w as any).active : undefined;
        return { id, name, active };
      })
      .filter((x): x is WfRow => x !== null);
    return { rows, rawText: rows.length ? null : JSON.stringify(raw, null, 2) };
  }
  if (typeof raw === "string") return { rows: [], rawText: raw };
  return { rows: [], rawText: JSON.stringify(raw, null, 2) };
}

export default function N8nControlPanelPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isSuperAdmin = user?.role === "super_admin";

  const [status, setStatus] = useState<StatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [wfRows, setWfRows] = useState<WfRow[]>([]);
  const [wfRaw, setWfRaw] = useState<string | null>(null);
  const [wfLoading, setWfLoading] = useState(false);
  const [wfError, setWfError] = useState<string | null>(null);

  const [execId, setExecId] = useState("");
  const [execInputs, setExecInputs] = useState("{}");
  const [execMode, setExecMode] = useState<"production" | "test">("production");
  const [execBusy, setExecBusy] = useState(false);
  const [execResult, setExecResult] = useState<{ executionId: string | null; result: unknown } | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await apiFetchRaw("/api/automations/n8n/status");
      if (res.status === 403) {
        setStatus({ configured: false, ok: false, message: "Owner-only. You need the super_admin role." });
        return;
      }
      const data = (await res.json()) as StatusResult;
      setStatus(data);
    } catch (e: any) {
      setStatus({ configured: false, ok: false, error: e?.message ?? "probe failed" });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) void probe();
  }, [isSuperAdmin, probe]);

  async function loadWorkflows() {
    setWfLoading(true);
    setWfError(null);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set("query", query.trim());
      qs.set("limit", "50");
      const res = await apiFetchRaw(`/api/automations/n8n/workflows?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ?? data?.message ?? `HTTP ${res.status}`);
      }
      const { rows, rawText } = coerceWorkflows(data?.workflows);
      setWfRows(rows);
      setWfRaw(rawText);
    } catch (e: any) {
      setWfError(e?.message ?? "Failed to list workflows");
      setWfRows([]);
      setWfRaw(null);
    } finally {
      setWfLoading(false);
    }
  }

  async function execute() {
    if (!execId.trim()) {
      toast({ title: "Workflow ID required", description: "Enter or pick a workflow id to run.", variant: "destructive" });
      return;
    }
    let inputs: Record<string, unknown> = {};
    if (execInputs.trim()) {
      try {
        const parsed = JSON.parse(execInputs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputs = parsed;
        else throw new Error("Inputs must be a JSON object");
      } catch (e: any) {
        toast({ title: "Invalid inputs JSON", description: e?.message ?? "Fix the JSON and retry.", variant: "destructive" });
        return;
      }
    }
    setExecBusy(true);
    setExecError(null);
    setExecResult(null);
    try {
      const res = await apiFetchRaw("/api/automations/n8n/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: execId.trim(), inputs, executionMode: execMode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? `HTTP ${res.status}`);
      setExecResult({ executionId: data?.executionId ?? null, result: data?.result ?? null });
      toast({ title: "Workflow triggered", description: data?.executionId ? `Execution ${data.executionId}` : "Sent to n8n." });
    } catch (e: any) {
      setExecError(e?.message ?? "Execute failed");
    } finally {
      setExecBusy(false);
    }
  }

  function copy(text: string, what = "Copied") {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: what, description: "Copied to clipboard." }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="container mx-auto p-6 max-w-2xl">
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <AlertTriangle className="h-10 w-10 mx-auto text-amber-500" />
            <div className="font-semibold text-lg">Owner only</div>
            <p className="text-sm text-muted-foreground">
              The n8n control panel drives the platform's global n8n instance and is restricted to the
              super_admin owner account.
            </p>
            <Button variant="outline" asChild>
              <Link href="/automations"><ArrowLeft className="h-4 w-4 mr-1" /> Back to Automations</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      <header className="space-y-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1">
          <Link href="/automations"><ArrowLeft className="h-4 w-4 mr-1" /> Automations</Link>
        </Button>
        <div className="flex items-center gap-3">
          <Workflow className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">n8n Control Panel</h1>
            <p className="text-muted-foreground">
              Probe, browse, and run workflows on the platform's global n8n instance (CRM → n8n).
            </p>
          </div>
        </div>
      </header>

      {/* Isolation note */}
      <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          This panel controls the <strong>owner's global n8n</strong> (set via <code>N8N_MCP_URL</code> /{" "}
          <code>N8N_MCP_TOKEN</code>). Per-firm automations use each firm's <strong>own</strong> n8n connection from{" "}
          <Link href="/integrations" className="underline">Integrations</Link> and never reach this instance.
        </span>
      </div>

      {/* Connection status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Plug className="h-5 w-5" /> Connection</CardTitle>
          <Button size="sm" variant="outline" onClick={probe} disabled={statusLoading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${statusLoading ? "animate-spin" : ""}`} /> Re-check
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {!status && statusLoading && <p className="text-sm text-muted-foreground">Probing…</p>}
          {status && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {status.ok ? (
                  <Badge className="bg-green-600 hover:bg-green-600"><CheckCircle2 className="h-3 w-3 mr-1" /> Connected</Badge>
                ) : status.configured ? (
                  <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" /> Unreachable</Badge>
                ) : (
                  <Badge variant="secondary">Not configured</Badge>
                )}
                {status.serverInfo?.name && (
                  <span className="text-sm text-muted-foreground">
                    {status.serverInfo.name}{status.serverInfo.version ? ` v${status.serverInfo.version}` : ""}
                  </span>
                )}
                {typeof status.toolCount === "number" && (
                  <Badge variant="outline" className="text-xs">{status.toolCount} tools</Badge>
                )}
              </div>
              {(status.message || status.error) && (
                <p className="text-sm text-muted-foreground">{status.message ?? status.error}</p>
              )}
              {!status.configured && (
                <p className="text-xs text-muted-foreground">
                  Set <code>N8N_MCP_URL</code> and <code>N8N_MCP_TOKEN</code> in the server environment (and on Render
                  for production) to connect the global instance.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Workflow browser */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Search className="h-5 w-5" /> Workflows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Search workflows by name (leave blank for all)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void loadWorkflows(); }}
            />
            <Button onClick={loadWorkflows} disabled={wfLoading || !status?.ok}>
              <Search className="h-4 w-4 mr-1" /> {wfLoading ? "Loading…" : "List"}
            </Button>
          </div>
          {!status?.ok && (
            <p className="text-xs text-muted-foreground">Connect the instance above to browse workflows.</p>
          )}
          {wfError && <p className="text-sm text-destructive">{wfError}</p>}
          {wfRows.length > 0 && (
            <div className="space-y-2">
              {wfRows.map((w) => (
                <div key={w.id} className="flex items-center justify-between gap-2 p-3 border rounded">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{w.name}</div>
                    <code className="text-xs text-muted-foreground">{w.id}</code>
                    {w.active === false && <Badge variant="secondary" className="ml-2 text-[10px]">inactive</Badge>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => copy(w.id, "Workflow ID copied")}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setExecId(w.id); document.getElementById("n8n-exec")?.scrollIntoView({ behavior: "smooth" }); }}>
                      <Play className="h-3.5 w-3.5 mr-1" /> Use
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {wfRaw && (
            <pre className="px-3 py-2 bg-muted rounded font-mono text-xs overflow-x-auto max-h-72 whitespace-pre-wrap">{wfRaw}</pre>
          )}
          {!wfLoading && !wfError && wfRows.length === 0 && !wfRaw && status?.ok && (
            <p className="text-xs text-muted-foreground">No results yet — click "List".</p>
          )}
        </CardContent>
      </Card>

      {/* Execute */}
      <Card id="n8n-exec">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Play className="h-5 w-5" /> Run a workflow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="exec-id">Workflow ID</Label>
            <Input id="exec-id" placeholder="paste or pick from the list above" value={execId} onChange={(e) => setExecId(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="exec-inputs">Inputs (JSON object)</Label>
            <Textarea
              id="exec-inputs"
              rows={4}
              className="font-mono text-xs"
              value={execInputs}
              onChange={(e) => setExecInputs(e.target.value)}
              placeholder='{"lead_id": 123}'
            />
          </div>
          <div className="flex items-center gap-3">
            <div>
              <Label htmlFor="exec-mode" className="text-xs uppercase text-muted-foreground">Mode</Label>
              <select
                id="exec-mode"
                className="block mt-1 h-9 rounded-md border bg-background px-3 text-sm"
                value={execMode}
                onChange={(e) => setExecMode(e.target.value as "production" | "test")}
              >
                <option value="production">production</option>
                <option value="test">test</option>
              </select>
            </div>
            <Button className="mt-5" onClick={execute} disabled={execBusy || !status?.ok}>
              <Play className="h-4 w-4 mr-1" /> {execBusy ? "Running…" : "Run workflow"}
            </Button>
          </div>
          {execError && <p className="text-sm text-destructive">{execError}</p>}
          {execResult && (
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center gap-2">
                <Badge className="bg-green-600 hover:bg-green-600"><CheckCircle2 className="h-3 w-3 mr-1" /> Triggered</Badge>
                {execResult.executionId && (
                  <span className="text-sm">Execution: <code className="text-xs">{execResult.executionId}</code></span>
                )}
              </div>
              {execResult.result != null && (
                <pre className="px-3 py-2 bg-muted rounded font-mono text-xs overflow-x-auto max-h-72 whitespace-pre-wrap">
                  {typeof execResult.result === "string" ? execResult.result : JSON.stringify(execResult.result, null, 2)}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
