/**
 * /admin/snapshots — operator-initiated config snapshots for disaster
 * recovery. Lets the admin:
 *   • take a named snapshot of their firm's operational config
 *   • download the raw JSON
 *   • restore from a snapshot (per-table opt-in, with a dry-run preview
 *     so the operator sees exactly which rows would be inserted /
 *     updated BEFORE applying)
 *   • delete a snapshot
 *
 * Backed by /api/admin/snapshots (admin-snapshots.ts). Permission gate:
 * SNAPSHOT_MANAGE (admin + super_admin only).
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Camera, Download, Trash2, RotateCcw, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface Snapshot {
  id: number;
  name: string;
  notes: string | null;
  byte_size: number;
  summary: Record<string, number>;
  created_by_user_id: number;
  created_at: string;
}

interface RestorePlan {
  table: string;
  to_insert: number;
  to_update: number;
  skipped: number;
}

const TABLES = [
  { id: "workflow_settings",     label: "Workflow settings",   note: "Default email/fax/esign providers and auto-send toggles." },
  { id: "integrations",          label: "Integrations",        note: "Provider metadata only — credentials stay in the vault and are never copied into a snapshot." },
  { id: "automation_workflows",  label: "Automation workflows", note: "Workflow graphs (nodes + edges) for every saved automation." },
  { id: "document_templates",    label: "Document templates",  note: "Reusable PDF and AI templates. Global at the schema layer." },
] as const;

type TableId = (typeof TABLES)[number]["id"];

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function AdminSnapshotsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form state
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [createTables, setCreateTables] = useState<Record<TableId, boolean>>(() =>
    Object.fromEntries(TABLES.map((t) => [t.id, true])) as Record<TableId, boolean>,
  );
  const [creating, setCreating] = useState(false);

  // Restore drawer state (per-row)
  const [restoreOpen, setRestoreOpen] = useState<number | null>(null);
  const [restoreTables, setRestoreTables] = useState<Record<TableId, boolean>>(() =>
    Object.fromEntries(TABLES.map((t) => [t.id, true])) as Record<TableId, boolean>,
  );
  const [restorePlans, setRestorePlans] = useState<RestorePlan[] | null>(null);
  const [restoring, setRestoring] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/admin/snapshots");
      if (res.ok) {
        const j = await res.json();
        setRows(j.snapshots ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  async function createSnapshot() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give this snapshot a label so future-you remembers what it was for.", variant: "destructive" });
      return;
    }
    const tables = (Object.entries(createTables) as [TableId, boolean][])
      .filter(([, on]) => on)
      .map(([t]) => t);
    if (tables.length === 0) {
      toast({ title: "Select at least one table", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetchRaw("/api/admin/snapshots", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), notes: notes.trim() || undefined, tables }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || res.statusText);
      }
      toast({ title: "Snapshot created" });
      setName("");
      setNotes("");
      void loadAll();
    } catch (err) {
      toast({ title: "Snapshot failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  function downloadSnapshot(id: number) {
    // apiFetchRaw can't conveniently trigger a browser download because we
    // need the response as a Blob and a programmatic <a download>. Use the
    // direct path here — backend reads the JWT from Authorization header
    // which apiFetchRaw doesn't help with for browser-initiated downloads,
    // so instead we fetch the JSON via apiFetchRaw and assemble a Blob.
    void (async () => {
      const res = await apiFetchRaw(`/api/admin/snapshots/${id}?download=1`);
      if (!res.ok) {
        toast({ title: "Download failed", description: res.statusText, variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mtos-snapshot-${id}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })();
  }

  async function deleteSnapshot(id: number) {
    if (!window.confirm("Delete this snapshot? This cannot be undone.")) return;
    const res = await apiFetchRaw(`/api/admin/snapshots/${id}`, { method: "DELETE" });
    if (res.status === 204) {
      toast({ title: "Snapshot deleted" });
      void loadAll();
    } else {
      const j = await res.json().catch(() => ({}));
      toast({ title: "Delete failed", description: j.message || res.statusText, variant: "destructive" });
    }
  }

  async function previewRestore(id: number) {
    const tables = (Object.entries(restoreTables) as [TableId, boolean][])
      .filter(([, on]) => on)
      .map(([t]) => t);
    if (tables.length === 0) {
      toast({ title: "Select at least one table", variant: "destructive" });
      return;
    }
    setRestoring(true);
    setRestorePlans(null);
    try {
      const res = await apiFetchRaw(`/api/admin/snapshots/${id}/restore`, {
        method: "POST",
        body: JSON.stringify({ tables, dry_run: true }),
        headers: { "Content-Type": "application/json" },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || res.statusText);
      setRestorePlans(j.plans);
    } catch (err) {
      toast({ title: "Preview failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  }

  async function applyRestore(id: number) {
    if (!restorePlans) return;
    const totalChanges = restorePlans.reduce((n, p) => n + p.to_insert + p.to_update, 0);
    if (!window.confirm(`Apply restore? ${totalChanges} row(s) will be inserted or updated across ${restorePlans.length} table(s).`)) return;
    const tables = restorePlans.map((p) => p.table) as TableId[];
    setRestoring(true);
    try {
      const res = await apiFetchRaw(`/api/admin/snapshots/${id}/restore`, {
        method: "POST",
        body: JSON.stringify({ tables, dry_run: false }),
        headers: { "Content-Type": "application/json" },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || res.statusText);
      toast({
        title: "Restore complete",
        description: j.plans.map((p: RestorePlan) => `${p.table}: +${p.to_insert} insert, ${p.to_update} update`).join(" · "),
      });
      setRestoreOpen(null);
      setRestorePlans(null);
    } catch (err) {
      toast({ title: "Restore failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto" data-testid="admin-snapshots-page">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Camera className="h-6 w-6" /> System Snapshots
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Per-firm operational-config backups. Take one before risky changes; restore after a failure or misconfiguration.
          Encrypted credentials never leave the vault — only metadata.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Camera className="h-4 w-4" /> New snapshot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="snap-name">Name</Label>
              <Input
                id="snap-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. before-doctor-fax-rollout-2026-05"
                data-testid="input-snapshot-name"
              />
            </div>
            <div>
              <Label htmlFor="snap-notes">Notes (optional)</Label>
              <Input
                id="snap-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Free-form context for future-you"
                data-testid="input-snapshot-notes"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Tables to include</Label>
            {TABLES.map((t) => (
              <label key={t.id} className="flex items-start gap-2 text-sm py-1">
                <Checkbox
                  checked={!!createTables[t.id]}
                  onCheckedChange={(v) => setCreateTables((m) => ({ ...m, [t.id]: !!v }))}
                  data-testid={`checkbox-create-${t.id}`}
                />
                <div>
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">{t.note}</div>
                </div>
              </label>
            ))}
          </div>
          <Button onClick={createSnapshot} disabled={creating} data-testid="button-create-snapshot">
            {creating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
            Take snapshot
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved snapshots</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No snapshots yet. Take one above.</div>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.id} className="border rounded-md p-3" data-testid={`row-snapshot-${r.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{r.name}</span>
                        <Badge variant="outline" className="text-xs">{fmtBytes(r.byte_size)}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {relTime(r.created_at)} · {Object.entries(r.summary).map(([k, v]) => `${k}=${v}`).join(", ")}
                      </div>
                      {r.notes && <div className="text-xs italic mt-1">{r.notes}</div>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRestoreOpen(r.id === restoreOpen ? null : r.id);
                          setRestorePlans(null);
                        }}
                        title="Restore from this snapshot"
                        data-testid={`button-restore-${r.id}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => downloadSnapshot(r.id)} title="Download JSON" data-testid={`button-download-${r.id}`}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteSnapshot(r.id)} title="Delete" data-testid={`button-delete-${r.id}`}>
                        <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                      </Button>
                    </div>
                  </div>

                  {restoreOpen === r.id && (
                    <div className="mt-3 border-t pt-3 space-y-3" data-testid={`panel-restore-${r.id}`}>
                      <div className="text-xs flex items-center gap-1 text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" /> Restoring upserts by natural key. Existing rows NOT in the snapshot are untouched.
                      </div>
                      <div className="space-y-1">
                        {TABLES.map((t) => (
                          <label key={t.id} className="flex items-start gap-2 text-sm py-0.5">
                            <Checkbox
                              checked={!!restoreTables[t.id]}
                              onCheckedChange={(v) => setRestoreTables((m) => ({ ...m, [t.id]: !!v }))}
                              data-testid={`checkbox-restore-${r.id}-${t.id}`}
                            />
                            <div>
                              <div>{t.label}</div>
                              <div className="text-xs text-muted-foreground">{r.summary[t.id] ?? 0} rows in snapshot</div>
                            </div>
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => previewRestore(r.id)} disabled={restoring} data-testid={`button-preview-${r.id}`}>
                          {restoring ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                          Preview (dry run)
                        </Button>
                        {restorePlans && (
                          <Button size="sm" onClick={() => applyRestore(r.id)} disabled={restoring} data-testid={`button-apply-${r.id}`}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                            Apply restore
                          </Button>
                        )}
                      </div>
                      {restorePlans && (
                        <div className="text-xs space-y-0.5" data-testid={`plans-${r.id}`}>
                          {restorePlans.map((p) => (
                            <div key={p.table} className="font-mono">
                              {p.table}: <span className="text-emerald-700">+{p.to_insert}</span> insert · <span className="text-blue-700">{p.to_update}</span> update{p.skipped > 0 ? <> · <span className="text-rose-700">{p.skipped} skipped</span></> : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
