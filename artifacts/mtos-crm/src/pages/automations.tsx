import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Workflow, Plus, Play, Trash2, Pencil, Upload, Copy, Plug, Sparkles, Megaphone } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";
import { getLucide } from "@/lib/lucide-icon";
import {
  AUTOMATION_STARTER_TEMPLATES,
  buildBlankWorkflowGraph,
  getAutomationStarterTemplate,
} from "@/lib/automation-templates";

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
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(AUTOMATION_STARTER_TEMPLATES[0]?.id ?? "");

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/automations");
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast({ title: "Failed to load automations", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function createAutomation(templateId?: string, options?: { name?: string; description?: string; closeDialog?: boolean }) {
    const template = getAutomationStarterTemplate(templateId);
    const resolvedName = options?.name?.trim() || template?.name || "New Workflow";
    const resolvedDescription = options?.description?.trim() || template?.description || null;
    try {
      const res = await apiFetchRaw("/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: resolvedName,
          description: resolvedDescription,
          graph: template?.graph ?? buildBlankWorkflowGraph(),
          tags: template?.tags ?? [],
        }),
      });
      const wf = await res.json();
      toast({ title: "Workflow created", description: `#${wf.id} ${wf.name}` });
      if (options?.closeDialog) {
        setCreateOpen(false);
        setNewName("");
        setNewDesc("");
      }
      navigate(`/automations/${wf.id}`);
    } catch (e: any) {
      toast({ title: "Create failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  async function createOne() {
    await createAutomation(selectedTemplateId, {
      name: newName,
      description: newDesc,
      closeDialog: true,
    });
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
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Workflow className="h-6 w-6" /> Automations</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Start with big, simple workflow blocks like web form intake, review routing, and medical records instead of staring at a wall of tiny nodes.
          </p>
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
          <Button variant="outline" size="sm" asChild>
            <Link href="/outreach"><Megaphone className="h-4 w-4 mr-1" /> Outreach</Link>
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1" /> New Workflow</Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Megaphone className="h-4 w-4 text-primary" /> Outreach</CardTitle>
            <CardDescription>Upload a claimant CSV, upsert existing matches, and launch re-intake outreach from one guided screen.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Use Outreach when the team already has leads to re-contact and needs email, SMS, or Vapi voice follow-up without creating duplicate claimant records.</p>
            <Button asChild>
              <Link href="/outreach"><Megaphone className="h-4 w-4 mr-1" /> Open outreach</Link>
            </Button>
          </CardContent>
        </Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-lg font-semibold">Quick-start big blocks</h2>
          </div>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {AUTOMATION_STARTER_TEMPLATES.map((template) => {
            const Icon = getLucide(template.icon);
            return (
              <Card key={template.id} className="border-primary/10">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <CardTitle className="text-base flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Icon className="h-4 w-4" />
                        </span>
                        {template.name}
                      </CardTitle>
                      <CardDescription>{template.summary}</CardDescription>
                    </div>
                    <Badge variant="outline">Starter</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground min-h-[3rem]">{template.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {template.tags.map((tag) => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}
                  </div>
                  <Button className="w-full" size="sm" onClick={() => createAutomation(template.id)}>
                    <Plus className="h-4 w-4 mr-1" /> Use starter
                  </Button>
                </CardContent>
              </Card>
            );
          })}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Workflow className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <div className="font-medium">No workflows yet</div>
            <div className="text-sm text-muted-foreground">Pick a starter above or create one from the guided builder below.</div>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Workflow</DialogTitle>
            <DialogDescription>Choose a starter so your team begins with a big, friendly block instead of an empty automation canvas.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Starter template</Label>
              <div className="grid gap-2 md:grid-cols-2">
                {AUTOMATION_STARTER_TEMPLATES.map((template) => {
                  const Icon = getLucide(template.icon);
                  const selected = selectedTemplateId === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`rounded-lg border p-3 text-left transition ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                    >
                      <div className="flex items-start gap-3">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="space-y-1 min-w-0">
                          <div className="font-medium text-sm">{template.name}</div>
                          <p className="text-xs text-muted-foreground">{template.summary}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label>Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={getAutomationStarterTemplate(selectedTemplateId)?.name ?? "Lead-to-MRR auto-pipeline"} />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Textarea rows={3} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={getAutomationStarterTemplate(selectedTemplateId)?.description ?? "Describe what this workflow should accomplish."} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createOne}>Create & Open Builder</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
