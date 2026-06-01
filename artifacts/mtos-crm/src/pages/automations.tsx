import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Workflow, Plus, Play, Trash2, Pencil, Upload, Copy, Plug } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";

interface Wf {
  id: number;
  firm_id: number | null;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: string;
  tags: string[];
  updated_at: string;
}

export default function AutomationsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const [items, setItems] = useState<Wf[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/automations");
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast({ title: "Failed to load automations", description: e?.message ?? String(e), variant: "destructive" });
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function createOne() {
    if (!newName.trim()) return;
    try {
      const res = await apiFetchRaw("/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDesc.trim() || null,
          graph: {
            nodes: [{ id: "n1", type: "trigger.manual", position: { x: 100, y: 200 }, data: { label: "Manual Trigger", params: {} } }],
            edges: [],
          },
        }),
      });
      const wf = await res.json();
      toast({ title: "Workflow created", description: `#${wf.id} ${wf.name}` });
      setCreateOpen(false); setNewName(""); setNewDesc("");
      navigate(`/automations/${wf.id}`);
    } catch (e: any) {
      toast({ title: "Create failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  async function clone(id: number) {
    try {
      const res = await apiFetchRaw(`/api/automations/${id}/clone`, { method: "POST" });
      const wf = await res.json();
      toast({ title: "Cloned to your firm", description: `#${wf.id} ${wf.name}` });
      navigate(`/automations/${wf.id}`);
    } catch (e: any) {
      toast({ title: "Clone failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this workflow and all its run history?")) return;
    try {
      await apiFetchRaw(`/api/automations/${id}`, { method: "DELETE" });
      setItems((p) => p.filter((w) => w.id !== id));
      toast({ title: "Workflow deleted" });
    } catch (e: any) {
      toast({ title: "Delete failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  async function importJson(file: File) {
    try {
      const text = await file.text();
      const wf = JSON.parse(text);
      const res = await apiFetchRaw("/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: wf.name ?? `Imported ${file.name}`,
          description: wf.description ?? null,
          graph: wf.graph ?? { nodes: [], edges: [] },
          tags: wf.tags ?? [],
        }),
      });
      const created = await res.json();
      toast({ title: "Imported", description: `#${created.id} ${created.name}` });
      load();
    } catch (e: any) {
      toast({ title: "Import failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Workflow className="h-6 w-6" /> Automations</h1>
          <p className="text-sm text-muted-foreground">Drag-and-drop workflows. Wire any CRM action together — triggers, logic, scripts, integrations.</p>
        </div>
        <div className="flex gap-2">
          {isSuperAdmin && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/n8n-control"><Plug className="h-4 w-4 mr-1" /> n8n Control Panel</Link>
            </Button>
          )}
          <label className="inline-flex">
            <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
            <Button variant="outline" size="sm" asChild><span className="cursor-pointer"><Upload className="h-4 w-4 mr-1" /> Import JSON</span></Button>
          </label>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1" /> New Workflow</Button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Workflow className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <div className="font-medium">No workflows yet</div>
            <div className="text-sm text-muted-foreground">Create your first automation to chain CRM actions, integrations, and scripts.</div>
            <Button size="sm" className="mt-2" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1" /> Create Workflow</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {items.map((wf) => {
            const isSystem = wf.firm_id == null;
            return (
            <Card key={wf.id} className="hover:border-primary/50 transition">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{wf.name}</CardTitle>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant={wf.enabled ? "default" : "secondary"}>{wf.enabled ? "enabled" : "draft"}</Badge>
                    {isSystem && <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">System template</Badge>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">{wf.description || <span className="italic">No description</span>}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="font-mono">trigger:</span> <Badge variant="outline" className="text-[10px]">{wf.trigger_type}</Badge>
                </div>
                {isSystem ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">Read-only shared template. Clone it into your firm to fill in document templates and enable it.</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="default" onClick={() => clone(wf.id)}><Copy className="h-3 w-3 mr-1" /> Clone to my firm</Button>
                      <Button size="sm" variant="outline" asChild><Link href={`/automations/${wf.id}`}><Pencil className="h-3 w-3 mr-1" /> View</Link></Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="default" asChild><Link href={`/automations/${wf.id}`}><Pencil className="h-3 w-3 mr-1" /> Edit</Link></Button>
                    <Button size="sm" variant="outline" onClick={() => navigate(`/automations/${wf.id}?run=1`)}><Play className="h-3 w-3 mr-1" /> Run</Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => remove(wf.id)}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                )}
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workflow</DialogTitle>
            <DialogDescription>Give it a name. You'll wire the nodes in the editor.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Lead-to-MRR auto-pipeline" /></div>
            <div><Label>Description (optional)</Label><Textarea rows={2} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createOne} disabled={!newName.trim()}>Create & Open Editor</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
