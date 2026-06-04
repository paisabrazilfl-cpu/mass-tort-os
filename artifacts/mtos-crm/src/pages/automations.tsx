import { Fragment, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Workflow, Plus, Play, Trash2, Pencil, Upload, Copy, Plug, Sparkles, Megaphone, ChevronRight, ArrowRight, Zap } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";
import { getLucide } from "@/lib/lucide-icon";
import {
  AUTOMATION_STARTER_TEMPLATES,
  buildBlankWorkflowGraph,
  getAutomationStarterTemplate,
  type AutomationStarterTemplate,
} from "@/lib/automation-templates";

// ─── Category color map (mirrors editor) ─────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  triggers: "bg-blue-600",
  trigger: "bg-blue-600",
  crm: "bg-emerald-600",
  messaging: "bg-violet-600",
  comm: "bg-violet-600",
  documents: "bg-orange-500",
  ai: "bg-pink-500",
  logic: "bg-slate-500",
  scripts: "bg-amber-500",
  data: "bg-teal-600",
  io: "bg-cyan-600",
  utility: "bg-gray-500",
  integrations: "bg-indigo-600",
};

function catColor(category: string | undefined): string {
  return CATEGORY_COLORS[(category ?? "").toLowerCase()] ?? "bg-slate-600";
}

// Minimal per-template node type lookup used only for flow-strip previews
// (the full catalog is only available inside the editor). We derive colors
// from the node-type prefix (trigger/crm/documents/messaging/…).
function nodeTypeToCategory(type: string): string {
  const prefix = type.split(".")[0];
  return prefix;
}

// ─── FlowStrip — visual preview of a starter's node sequence ─────────────────
function FlowStrip({ template, maxNodes = 6 }: { template: AutomationStarterTemplate; maxNodes?: number }) {
  const preview = template.graph.nodes.slice(0, maxNodes);
  const extra = template.graph.nodes.length - maxNodes;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {preview.map((n, i) => {
        const cat = nodeTypeToCategory(n.type);
        const cc = catColor(cat);
        const Icon = getLucide("Box"); // generic fallback — real icons load inside the editor
        return (
          <Fragment key={n.id}>
            <div className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${cc} shadow-sm`}>
              <span className="text-[10px] font-semibold text-white whitespace-nowrap">
                {n.data.label}
              </span>
            </div>
            {i < preview.length - 1 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
          </Fragment>
        );
      })}
      {extra > 0 && (
        <span className="text-[10px] text-muted-foreground ml-1">+{extra} more</span>
      )}
    </div>
  );
}

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
    await createAutomation(selectedTemplateId, { name: newName, description: newDesc, closeDialog: true });
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
    <div className="p-6 space-y-8">
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <WorkspaceHero
        eyebrow="Operations"
        title="Automation Workflows"
        description="Build powerful workflows from big, visual blocks — no tiny node wall. Start with a guided starter flow, then add or customize blocks across 37 node types."
        badge="37-node catalog"
      />
      <div className="flex gap-2 flex-wrap justify-end">
          {isSuperAdmin && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/n8n-control"><Plug className="h-4 w-4 mr-1" /> n8n Control</Link>
            </Button>
          )}
          <label className="inline-flex">
            <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
            <Button variant="outline" size="sm" asChild>
              <span className="cursor-pointer"><Upload className="h-4 w-4 mr-1" /> Import JSON</span>
            </Button>
          </label>
          <Button variant="outline" size="sm" asChild>
            <Link href="/outreach"><Megaphone className="h-4 w-4 mr-1" /> Outreach</Link>
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Workflow
          </Button>
      </div>

      {/* ── Starter Flows — big block cards with visual flow previews ─────── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold">Starter Flows</h2>
          <Badge variant="secondary" className="text-[10px]">Big blocks first</Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {AUTOMATION_STARTER_TEMPLATES.map((template) => {
            const Icon = getLucide(template.icon);
            // Derive a dominant color from the first node's category
            const firstNodeCat = nodeTypeToCategory(template.graph.nodes[0]?.type ?? "");
            const headerColor = catColor(firstNodeCat);
            return (
              <div
                key={template.id}
                className="group rounded-xl border border-border/60 bg-background overflow-hidden hover:border-primary/50 hover:shadow-md transition-all cursor-pointer"
                onClick={() => createAutomation(template.id)}
              >
                {/* Colored top bar */}
                <div className={`flex items-center gap-3 px-4 py-3 ${headerColor}`}>
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/20">
                    <Icon className="h-4 w-4 text-white" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-white leading-tight truncate">{template.name}</div>
                    <div className="text-[10px] text-white/80 truncate">{template.summary}</div>
                  </div>
                  <Badge className="ml-auto bg-white/20 text-white border-0 text-[9px] shrink-0">Starter</Badge>
                </div>
                {/* Flow strip — visual node sequence */}
                <div className="px-4 py-3 border-b border-border/40 bg-muted/20">
                  <FlowStrip template={template} maxNodes={5} />
                </div>
                {/* Description + tags + action */}
                <div className="px-4 py-3 space-y-2.5">
                  <p className="text-xs text-muted-foreground leading-relaxed">{template.description}</p>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {template.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[9px] px-1.5 py-0">{tag}</Badge>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0 group-hover:translate-x-0.5 transition-transform"
                      onClick={(e) => { e.stopPropagation(); createAutomation(template.id); }}
                    >
                      <Zap className="h-3.5 w-3.5 mr-1" /> Use this flow
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Blank starter */}
          <div
            className="group rounded-xl border-2 border-dashed border-border/50 bg-background overflow-hidden hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer flex flex-col items-center justify-center p-8 text-center gap-3 min-h-[200px]"
            onClick={() => setCreateOpen(true)}
          >
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
              <Plus className="h-6 w-6" />
            </div>
            <div>
              <div className="font-semibold text-sm">Blank Workflow</div>
              <div className="text-xs text-muted-foreground mt-0.5">Start from scratch with the guided builder</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Outreach shortcut ─────────────────────────────────────────────── */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex items-center gap-4 py-4">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
            <Megaphone className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm">Outreach Blaster</div>
            <div className="text-xs text-muted-foreground">Upload a claimant CSV and launch re-intake email, SMS, or voice outreach in one guided screen — no duplicate records.</div>
          </div>
          <Button asChild className="shrink-0">
            <Link href="/outreach"><Megaphone className="h-4 w-4 mr-1" /> Open Outreach</Link>
          </Button>
        </CardContent>
      </Card>

      {/* ── My Workflows ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
          <Workflow className="h-5 w-5" /> My Workflows
        </h2>
        {loading ? (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader className="pb-2">
                  <div className="h-5 bg-muted rounded w-2/3" />
                </CardHeader>
                <CardContent>
                  <div className="h-3 bg-muted rounded w-full mb-2" />
                  <div className="h-3 bg-muted rounded w-4/5" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center space-y-3">
              <Workflow className="h-12 w-12 mx-auto text-muted-foreground/30" />
              <div className="font-medium">No workflows yet</div>
              <div className="text-sm text-muted-foreground">Pick a starter flow above or create one from the guided builder.</div>
              <Button size="sm" className="mt-2" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Create Workflow
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {items.map((wf) => {
              const isSystemWf = wf.firm_id == null;
              const triggerCat = nodeTypeToCategory(wf.trigger_type);
              const triggerColor = catColor(triggerCat);
              return (
                <Card key={wf.id} className="hover:border-primary/50 hover:shadow-sm transition-all overflow-hidden">
                  <div className={`h-1 w-full ${wf.enabled ? "bg-emerald-500" : "bg-muted"}`} />
                  <CardHeader className="pb-2 pt-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm leading-snug">{wf.name}</CardTitle>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant={wf.enabled ? "default" : "secondary"} className="text-[10px]">
                          {wf.enabled ? "enabled" : "draft"}
                        </Badge>
                        {isSystemWf && (
                          <Badge variant="outline" className="text-[9px] border-amber-400 text-amber-700">system</Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
                      {wf.description || <span className="italic">No description</span>}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className={`inline-block w-2 h-2 rounded-full ${triggerColor}`} />
                      <span className="font-mono">{wf.trigger_type}</span>
                    </div>
                    {wf.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {wf.tags.map((t) => <Badge key={t} variant="outline" className="text-[9px] px-1.5">{t}</Badge>)}
                      </div>
                    )}
                    {isSystemWf ? (
                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground">Read-only shared template. Clone it to your firm to enable.</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="default" onClick={() => clone(wf.id)}>
                            <Copy className="h-3 w-3 mr-1" /> Clone
                          </Button>
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/automations/${wf.id}`}><Pencil className="h-3 w-3 mr-1" /> View</Link>
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="default" asChild>
                          <Link href={`/automations/${wf.id}`}><Pencil className="h-3 w-3 mr-1" /> Edit</Link>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => navigate(`/automations/${wf.id}?run=1`)}>
                          <Play className="h-3 w-3 mr-1" /> Run
                        </Button>
                        <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => remove(wf.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── New Workflow dialog ───────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Workflow</DialogTitle>
            <DialogDescription>
              Choose a starter flow so your team begins with big, friendly blocks instead of a blank canvas.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Starter flow</Label>
              <div className="grid gap-2 md:grid-cols-2">
                {AUTOMATION_STARTER_TEMPLATES.map((template) => {
                  const Icon = getLucide(template.icon);
                  const selected = selectedTemplateId === template.id;
                  const firstCat = nodeTypeToCategory(template.graph.nodes[0]?.type ?? "");
                  const hColor = catColor(firstCat);
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`rounded-xl border text-left transition-all overflow-hidden ${
                        selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-primary/50"
                      }`}
                    >
                      <div className={`flex items-center gap-2 px-3 py-1.5 ${hColor}`}>
                        <Icon className="h-3.5 w-3.5 text-white shrink-0" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-white">{template.name}</span>
                        {selected && <span className="ml-auto text-white/80 text-[10px]">✓</span>}
                      </div>
                      <div className="px-3 py-2 space-y-1.5">
                        <p className="text-xs text-muted-foreground leading-snug">{template.summary}</p>
                        <FlowStrip template={template} maxNodes={4} />
                      </div>
                    </button>
                  );
                })}
                {/* Blank option */}
                <button
                  type="button"
                  onClick={() => setSelectedTemplateId("")}
                  className={`rounded-xl border-2 border-dashed text-left transition-all flex items-center gap-3 px-3 py-3 ${
                    selectedTemplateId === "" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-muted shrink-0">
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div>
                    <div className="text-sm font-medium">Blank canvas</div>
                    <div className="text-xs text-muted-foreground">Start from scratch</div>
                  </div>
                </button>
              </div>
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={getAutomationStarterTemplate(selectedTemplateId)?.name ?? "My automation workflow"}
              />
            </div>
            <div>
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                rows={2}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder={getAutomationStarterTemplate(selectedTemplateId)?.description ?? "Describe what this workflow should accomplish."}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createOne}>
              <Zap className="h-4 w-4 mr-1" /> Create & Open Builder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
