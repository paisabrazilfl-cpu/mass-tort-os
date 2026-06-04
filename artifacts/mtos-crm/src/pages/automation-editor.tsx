import { Fragment, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import ReactFlow, {
  Background, Controls, MiniMap, addEdge,
  applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection,
  ReactFlowProvider, useReactFlow, MarkerType,
  Handle, Position, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Save, Play, Download, Trash2, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Sparkles, X, Loader2, Copy, ChevronRight as ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { apiFetchRaw } from "@/lib/api-fetch";
import { getLucide } from "@/lib/lucide-icon";
import { AUTOMATION_STARTER_TEMPLATES, getAutomationStarterTemplate } from "@/lib/automation-templates";

interface NodeParamSpec {
  key: string; label: string;
  type: "string" | "text" | "number" | "boolean" | "json" | "select" | "code";
  language?: string;
  options?: { label: string; value: string }[];
  placeholder?: string; default?: unknown; required?: boolean; help?: string;
}
interface NodeDef {
  type: string; label: string; category: string; description: string;
  icon: string; color: string; params: NodeParamSpec[];
  inputs?: number; outputs?: number | string[];
}

function uid(prefix = "n") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Category color mapping ────────────────────────────────────────────────────
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

// ─── BigBlockNode — custom ReactFlow node rendered as a large card ─────────────
function BigBlockNode({ data, selected }: NodeProps) {
  const Icon = getLucide(data.icon ?? "Box");
  const colorClass = data.color ?? catColor(data.category);
  const paramsEntries = Object.entries(data.params ?? {})
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .slice(0, 3) as [string, unknown][];

  return (
    <div
      className={`rounded-xl overflow-hidden shadow-md border-2 transition-all bg-background
        ${selected ? "border-primary ring-2 ring-primary/20 shadow-lg shadow-primary/10" : "border-border/70 hover:border-primary/40"}`}
      style={{ width: 248, minWidth: 248 }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "hsl(var(--primary))", width: 11, height: 11, top: -6, border: "2px solid hsl(var(--background))" }}
      />
      {/* Colored category header */}
      <div className={`flex items-center gap-2 px-3 py-1.5 ${colorClass}`}>
        <Icon className="h-3.5 w-3.5 text-white shrink-0" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/90 truncate">
          {data.category ?? "node"}
        </span>
      </div>
      {/* Body */}
      <div className="px-3 py-2.5 space-y-1.5">
        <div className="font-semibold text-sm leading-snug text-foreground">{data.label ?? data.nodeType}</div>
        {data.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">{data.description}</p>
        )}
        {paramsEntries.length > 0 && (
          <div className="mt-1 space-y-0.5 border-t border-border/40 pt-1.5">
            {paramsEntries.map(([k, v]) => (
              <div key={k} className="flex items-start gap-1 text-[10px]">
                <span className="text-muted-foreground font-mono shrink-0 min-w-0">{k}:</span>
                <span className="text-foreground/70 truncate min-w-0">{String(v).slice(0, 30)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "hsl(var(--primary))", width: 11, height: 11, bottom: -6, border: "2px solid hsl(var(--background))" }}
      />
    </div>
  );
}

// Registered outside the component tree so ReactFlow never sees a new reference
const NODE_TYPES = { bigBlock: BigBlockNode };

export default function AutomationEditorPage() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

function EditorInner() {
  const [, params] = useRoute("/automations/:id");
  const id = Number(params?.id);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const flow = useReactFlow();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [isSystem, setIsSystem] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [catalog, setCatalog] = useState<NodeDef[]>([]);
  const [openCat, setOpenCat] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState("{}");
  const [running, setRunning] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistPrompt, setAssistPrompt] = useState("");
  const [assistMode, setAssistMode] = useState<"replace" | "patch">("replace");
  const [assistLoading, setAssistLoading] = useState(false);
  const [assistResult, setAssistResult] = useState<{
    explanation: string;
    graph: { nodes: any[]; edges: any[] };
    mode: "replace" | "patch";
  } | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("mtos:automation:paletteOpen") !== "0";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("mtos:automation:paletteOpen", paletteOpen ? "1" : "0");
    }
  }, [paletteOpen]);
  const [configOpen, setConfigOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("mtos:automation:configOpen") !== "0";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("mtos:automation:configOpen", configOpen ? "1" : "0");
    }
  }, [configOpen]);
  const [simpleMode, setSimpleMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("mtos:automation:simpleMode") !== "0";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("mtos:automation:simpleMode", simpleMode ? "1" : "0");
    }
  }, [simpleMode]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Load workflow + catalog
  useEffect(() => {
    (async () => {
      try {
        const [wfRes, catRes] = await Promise.all([
          apiFetchRaw(`/api/automations/${id}`),
          apiFetchRaw("/api/automations/node-catalog"),
        ]);
        const wf = await wfRes.json();
        const cat = await catRes.json();
        setName(wf.name); setDescription(wf.description ?? ""); setEnabled(!!wf.enabled);
        setTags(wf.tags ?? []);
        setIsSystem(wf.firm_id == null);
        const g = wf.graph ?? { nodes: [], edges: [] };
        // Build a local lookup so we can bake visual metadata into each node immediately.
        const localCatByType: Record<string, NodeDef> = Object.fromEntries(
          (cat.nodes ?? []).map((n: NodeDef) => [n.type, n]),
        );
        setNodes((g.nodes ?? []).map((n: any) => {
          const nodeType = n.data?.nodeType ?? n.type;
          const def = localCatByType[nodeType];
          return {
            ...n,
            type: "bigBlock",
            position: n.position ?? { x: 100, y: 100 },
            data: {
              ...(n.data ?? {}),
              nodeType,
              params: n.data?.params ?? {},
              icon: def?.icon,
              color: def?.color,
              category: def?.category,
              description: def?.description,
            },
            style: undefined,
          };
        }));
        setEdges((g.edges ?? []).map((e: any) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed } })));
        setCatalog(cat.nodes ?? []);
        const cats = new Set<string>((cat.nodes ?? []).map((n: NodeDef) => n.category));
        setOpenCat(Object.fromEntries(Array.from(cats).map((c) => [c, true])));
        if ((window.location.search ?? "").includes("run=1")) setRunOpen(true);
      } catch (e: any) {
        toast({ title: "Failed to load workflow", description: e?.message, variant: "destructive" });
      }
    })();
  }, [id]);

  const catalogByType = useMemo(() => Object.fromEntries((Array.isArray(catalog) ? catalog : []).map((c) => [c.type, c])), [catalog]);
  const essentialNodeTypes = useMemo(() => new Set([
    "trigger.manual",
    "trigger.form_submitted",
    "trigger.lead_created",
    "trigger.document_signed",
    "crm.create_lead",
    "crm.decision_engine",
    "crm.set_lead_status",
    "crm.send_to_review_queue",
    "crm.assign_paralegal",
    "crm.add_note",
    "crm.consent_gate",
    "crm.npi_lookup",
    "documents.fax_medical_records",
    "documents.send_dropbox_sign",
    "documents.render_template",
    "comm.send_sms",
    "comm.send_calendar_invite",
  ]), []);
  const visibleGrouped = useMemo(() => {
    const source = simpleMode
      ? (Array.isArray(catalog) ? catalog : []).filter((node) => essentialNodeTypes.has(node.type))
      : (Array.isArray(catalog) ? catalog : []);
    const m: Record<string, NodeDef[]> = {};
    source.forEach((d) => { (m[d.category] ??= []).push(d); });
    return m;
  }, [catalog, simpleMode, essentialNodeTypes]);

  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es)), []);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: uid("e"), markerEnd: { type: MarkerType.ArrowClosed } }, es)), []);
  const onNodeClick = useCallback((_: any, n: Node) => { setSelectedId(n.id); }, []);
  const onPaneClick = useCallback(() => setSelectedId(null), []);

  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
    }
  }, [nodes, selectedId]);

  function addNode(def: NodeDef) {
    const center = wrapperRef.current?.getBoundingClientRect();
    const pos = flow.project({ x: (center?.width ?? 600) / 2 - 124, y: 100 });
    const n: Node = {
      id: uid(),
      type: "bigBlock",
      position: pos,
      data: {
        label: def.label,
        nodeType: def.type,
        icon: def.icon,
        color: def.color,
        category: def.category,
        description: def.description,
        params: Object.fromEntries(def.params.map((p) => {
          const seed = p.default ?? p.placeholder ?? "";
          if (p.type === "json" && typeof seed === "string" && seed.length > 0) {
            try { return [p.key, JSON.parse(seed)]; } catch { return [p.key, seed]; }
          }
          return [p.key, seed];
        })),
      },
    };
    setNodes((ns) => [...ns, n]);
  }

  function decorateNode(n: Node, def?: NodeDef): Node {
    const d = def ?? catalogByType[n.data?.nodeType];
    if (!d) return n;
    return {
      ...n,
      type: "bigBlock",
      data: {
        ...n.data,
        label: n.data?.label ?? d.label,
        nodeType: d.type,
        icon: d.icon,
        color: d.color,
        category: d.category,
        description: d.description,
      },
    };
  }

  function deleteSelected() {
    if (!selectedId) return;
    const sid = selectedId;
    setNodes((ns) => ns.filter((n) => n.id !== sid));
    setEdges((es) => es.filter((e) => e.source !== sid && e.target !== sid));
    setSelectedId(null);
  }

  function updateParam(key: string, value: any) {
    if (!selectedId) return;
    const sid = selectedId;
    setNodes((ns) => ns.map((n) => n.id === sid ? { ...n, data: { ...n.data, params: { ...(n.data?.params ?? {}), [key]: value } } } : n));
  }

  function updateLabel(label: string) {
    if (!selectedId) return;
    const sid = selectedId;
    setNodes((ns) => ns.map((n) => n.id === sid ? { ...n, data: { ...n.data, label } } : n));
  }

  function buildGraphForSave() {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.data?.nodeType ?? "trigger.manual",
        position: n.position,
        data: { label: n.data?.label, params: n.data?.params ?? {} },
      })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
      })),
    };
  }

  async function cloneToFirm() {
    setCloning(true);
    try {
      const res = await apiFetchRaw(`/api/automations/${id}/clone`, { method: "POST" });
      const wf = await res.json();
      toast({ title: "Cloned to your firm", description: `#${wf.id} ${wf.name}` });
      navigate(`/automations/${wf.id}`);
    } catch (e: any) {
      toast({ title: "Clone failed", description: e?.message, variant: "destructive" });
    } finally { setCloning(false); }
  }

  async function save() {
    if (isSystem) {
      toast({ title: "Read-only template", description: "Clone it to your firm to make changes.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetchRaw(`/api/automations/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, enabled, tags, graph: buildGraphForSave() }),
      });
      toast({ title: "Saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function run() {
    setRunning(true); setRunResult(null);
    try {
      let parsed: any = {};
      try { parsed = JSON.parse(runInput || "{}"); } catch { toast({ title: "Input is not valid JSON", variant: "destructive" }); setRunning(false); return; }
      await save();
      const res = await apiFetchRaw(`/api/automations/${id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: parsed }),
      });
      const data = await res.json();
      setRunResult(data);
      toast({ title: data.status === "completed" ? "Run completed" : "Run failed", variant: data.status === "completed" ? "default" : "destructive", description: data.error ?? `${data.steps?.length ?? 0} steps` });
    } catch (e: any) {
      toast({ title: "Run failed", description: e?.message, variant: "destructive" });
    } finally { setRunning(false); }
  }

  async function askAssistant() {
    const trimmed = assistPrompt.trim();
    if (trimmed.length < 3) { toast({ title: "Type a longer prompt", variant: "destructive" }); return; }
    setAssistLoading(true); setAssistError(null); setAssistResult(null);
    try {
      const res = await apiFetchRaw(`/api/automations/assist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmed, currentGraph: buildGraphForSave(), mode: assistMode }),
      });
      const data = await res.json();
      if (!res.ok || data.status === "error") {
        const issues = data?.details?.issues;
        setAssistError(Array.isArray(issues) ? issues.join("\n• ") : (data?.message ?? "Assistant failed"));
        return;
      }
      setAssistResult({ explanation: data.explanation ?? "", graph: data.graph, mode: data.mode ?? assistMode });
    } catch (e: any) {
      setAssistError(e?.message ?? String(e));
    } finally { setAssistLoading(false); }
  }

  function applyAssistResult() {
    if (!assistResult) return;
    const proposed = assistResult.graph;
    const proposedNodes: any[] = Array.isArray(proposed?.nodes) ? proposed.nodes : [];
    const proposedEdges: any[] = Array.isArray(proposed?.edges) ? proposed.edges : [];
    const ids = new Set(proposedNodes.map((n: any) => n.id));
    const badNodes = proposedNodes.filter((n: any) => !catalogByType[n.type]);
    const badEdges = proposedEdges.filter((e: any) => !ids.has(e.source) || !ids.has(e.target));
    if (badNodes.length > 0 || badEdges.length > 0) {
      const detail = [
        ...badNodes.map((n: any) => `unknown node type "${n.type}"`),
        ...badEdges.map((e: any) => `dangling edge ${e.id}`),
      ].join("; ");
      toast({ title: "Refused to apply proposal", description: detail, variant: "destructive" });
      return;
    }
    const newNodes = proposedNodes.map((n) => decorateNodeFromCatalog(n));
    const newEdges = proposedEdges.map((e) => ({
      ...e,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
    if (assistResult.mode === "replace") {
      setNodes(newNodes); setEdges(newEdges);
    } else {
      const incomingIds = new Set(newNodes.map((n) => n.id));
      setNodes((curr) => [...curr.filter((n) => !incomingIds.has(n.id)), ...newNodes]);
      const incomingEdgeIds = new Set(newEdges.map((e) => e.id));
      setEdges((curr) => [...curr.filter((e) => !incomingEdgeIds.has(e.id)), ...newEdges]);
    }
    toast({ title: "Workflow updated", description: assistResult.mode === "replace" ? "Graph replaced" : "Patch merged" });
    setAssistResult(null); setAssistOpen(false); setAssistPrompt("");
  }

  function decorateNodeFromCatalog(n: any): Node {
    const def = catalogByType[n.type];
    return {
      id: n.id,
      position: n.position ?? { x: 100, y: 100 },
      type: "bigBlock",
      data: {
        nodeType: n.type,
        label: n.data?.label ?? def?.label ?? n.type,
        params: n.data?.params ?? {},
        icon: def?.icon,
        color: def?.color,
        category: def?.category,
        description: def?.description,
      },
    } as Node;
  }

  function exportLocal() {
    const blob = new Blob([JSON.stringify({ name, description, tags, graph: buildGraphForSave() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/\W+/g, "_") || "workflow"}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function loadStarterTemplate(templateId: string) {
    const template = getAutomationStarterTemplate(templateId);
    if (!template) return;
    const nextNodes = template.graph.nodes.map((n) => decorateNodeFromCatalog(n));
    const nextEdges = template.graph.edges.map((e) => ({
      ...e,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
    setNodes(nextNodes);
    setEdges(nextEdges);
    if (!name.trim()) setName(template.name);
    if (!description.trim()) setDescription(template.description);
    setTags((current) => Array.from(new Set([...current, ...template.tags])));
    toast({ title: "Starter loaded", description: `${template.name} is now on the canvas.` });
  }

  const selected = useMemo(
    () => (selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null),
    [nodes, selectedId],
  );
  const selectedDef = selected ? catalogByType[selected.data?.nodeType] : undefined;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Toolbar */}
      <div className="border-b bg-background flex items-center gap-2 px-4 py-2">
        <Button variant="ghost" size="sm" asChild><Link href="/automations"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
        <Input className="max-w-md" value={name} onChange={(e) => setName(e.target.value)} placeholder="Workflow name" disabled={isSystem} />
        {isSystem ? (
          <Badge variant="outline" className="ml-2 border-amber-400 text-amber-700">System template · read-only</Badge>
        ) : (
          <div className="flex items-center gap-2 ml-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="enabled" />
            <Label htmlFor="enabled" className="text-xs">Enabled</Label>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border px-2 py-1">
            <Label htmlFor="simple-mode" className="text-xs">Big blocks only</Label>
            <Switch id="simple-mode" checked={simpleMode} onCheckedChange={setSimpleMode} />
          </div>
          <Button size="sm" variant="outline" onClick={exportLocal}><Download className="h-4 w-4 mr-1" /> Export</Button>
          {isSystem ? (
            <Button size="sm" onClick={cloneToFirm} disabled={cloning}><Copy className="h-4 w-4 mr-1" /> {cloning ? "Cloning…" : "Clone to my firm"}</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setAssistOpen(true)} data-testid="button-ai-assist"><Sparkles className="h-4 w-4 mr-1" /> AI Assist</Button>
              <Button size="sm" variant="outline" onClick={() => setRunOpen((v) => !v)}><Play className="h-4 w-4 mr-1" /> Run</Button>
              <Button size="sm" onClick={save} disabled={saving}><Save className="h-4 w-4 mr-1" /> {saving ? "Saving…" : "Save"}</Button>
            </>
          )}
        </div>
      </div>

      {/* AI Assistant drawer */}
      {assistOpen && (
        <div className="fixed inset-y-0 right-0 z-50 w-[420px] bg-background border-l shadow-2xl flex flex-col" data-testid="drawer-ai-assist">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-500" />
              <span className="font-semibold text-sm">AI Workflow Assistant</span>
            </div>
            <button onClick={() => setAssistOpen(false)} className="p-1 rounded hover:bg-muted" aria-label="Close" data-testid="button-close-assist">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-4 space-y-3 overflow-y-auto flex-1">
            <p className="text-xs text-muted-foreground">
              Describe the workflow you want. The assistant will propose a graph using only nodes from the catalog.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Prompt</Label>
              <Textarea
                value={assistPrompt}
                onChange={(e) => setAssistPrompt(e.target.value)}
                rows={5}
                placeholder="e.g. When a new lead comes in, run a background check; if clear, send a welcome email and assign a paralegal."
                data-testid="input-assist-prompt"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mode</Label>
              <Select value={assistMode} onValueChange={(v) => setAssistMode(v as "replace" | "patch")}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-assist-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="replace">Replace entire workflow</SelectItem>
                  <SelectItem value="patch">Append / patch existing</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={askAssistant} disabled={assistLoading} className="w-full" data-testid="button-ask-assist">
              {assistLoading ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Thinking…</> : <><Sparkles className="h-4 w-4 mr-1" /> Generate</>}
            </Button>
            {assistError && (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-destructive" data-testid="text-assist-error">
                {assistError}
              </div>
            )}
            {assistResult && (
              <div className="space-y-2 border rounded p-2 bg-muted/30" data-testid="block-assist-result">
                <div className="text-xs font-medium">Proposal</div>
                {assistResult.explanation && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{assistResult.explanation}</p>
                )}
                <div className="text-xs flex gap-3">
                  <Badge variant="secondary">{assistResult.graph.nodes.length} nodes</Badge>
                  <Badge variant="secondary">{assistResult.graph.edges.length} edges</Badge>
                  <Badge>{assistResult.mode}</Badge>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Show JSON</summary>
                  <pre className="mt-1 max-h-48 overflow-auto bg-background border rounded p-2 text-[10px]">{JSON.stringify(assistResult.graph, null, 2)}</pre>
                </details>
                <div className="flex gap-2">
                  <Button size="sm" onClick={applyAssistResult} className="flex-1" data-testid="button-apply-assist">Apply</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAssistResult(null)} data-testid="button-discard-assist">Discard</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* ── Big Block Palette ─────────────────────────────────────────────── */}
        {paletteOpen ? (
          <div className="w-80 border-r bg-muted/10 flex flex-col overflow-hidden">
            {/* Palette header */}
            <div className="p-3 flex items-center justify-between gap-2 border-b bg-background">
              <div>
                <div className="text-xs font-bold text-foreground">
                  {simpleMode ? "Big Blocks" : "All Blocks"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {simpleMode ? "Click a block to place it on the canvas" : "Full automation catalog"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPaletteOpen(false)}
                title="Collapse palette"
                aria-label="Collapse palette"
                className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground shrink-0"
              >
                <ChevronsLeft className="h-4 w-4" />
              </button>
            </div>

            <ScrollArea className="flex-1">
              {/* ── Starter flows ────────────────────────────── */}
              <div className="px-2.5 pt-3 pb-1">
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                  Starter Flows
                </div>
                <div className="space-y-1.5">
                  {AUTOMATION_STARTER_TEMPLATES.map((template) => {
                    const TIcon = getLucide(template.icon);
                    const previewNodes = template.graph.nodes.slice(0, 5);
                    return (
                      <button
                        key={template.id}
                        onClick={() => loadStarterTemplate(template.id)}
                        disabled={isSystem}
                        className="w-full rounded-lg border border-border/60 bg-background px-2.5 py-2 text-left
                          hover:border-primary/60 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60 transition-all group"
                      >
                        {/* Flow icon strip */}
                        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                          {previewNodes.map((n, i) => {
                            const def = catalogByType[n.type];
                            const Icon = getLucide(def?.icon ?? "Box");
                            const cc = def?.color ?? catColor(def?.category);
                            return (
                              <Fragment key={n.id}>
                                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${cc} shadow-sm shrink-0`}>
                                  <Icon className="h-3 w-3 text-white" />
                                </span>
                                {i < previewNodes.length - 1 && (
                                  <span className="text-muted-foreground text-[11px]">›</span>
                                )}
                              </Fragment>
                            );
                          })}
                          {template.graph.nodes.length > 5 && (
                            <span className="text-[10px] text-muted-foreground ml-1">
                              +{template.graph.nodes.length - 5} more
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-foreground leading-snug">{template.name}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{template.summary}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator className="my-2.5" />

              {/* ── Block categories ─────────────────────────── */}
              {Object.entries(visibleGrouped).map(([cat, list]) => {
                const cc = catColor(cat);
                return (
                  <div key={cat}>
                    <button
                      onClick={() => setOpenCat((s) => ({ ...s, [cat]: !s[cat] }))}
                      className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${cc}`} />
                        <span>{cat}</span>
                        <span className="text-muted-foreground font-normal normal-case">({list.length})</span>
                      </div>
                      {openCat[cat]
                        ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                    </button>
                    {openCat[cat] && (
                      <div className="px-2 pb-2 space-y-1.5">
                        {list.map((d) => {
                          const Icon = getLucide(d.icon);
                          const blockColor = d.color ?? catColor(d.category);
                          return (
                            <button
                              key={d.type}
                              onClick={() => addNode(d)}
                              title={d.description}
                              className="w-full text-left rounded-lg border border-border/60 bg-background
                                hover:border-primary/60 hover:bg-primary/5 transition-all overflow-hidden group"
                            >
                              {/* Colored top strip */}
                              <div className={`flex items-center gap-2 px-2.5 py-1 ${blockColor}`}>
                                <Icon className="h-3 w-3 text-white shrink-0" />
                                <span className="text-[9px] font-bold uppercase tracking-widest text-white/80 truncate">
                                  {d.category}
                                </span>
                              </div>
                              {/* Block info */}
                              <div className="px-2.5 py-1.5">
                                <div className="text-xs font-semibold text-foreground leading-snug">{d.label}</div>
                                <div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">{d.description}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="h-4" />
            </ScrollArea>
          </div>
        ) : (
          <div className="w-8 border-r bg-muted/20 flex flex-col items-center pt-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              title="Expand palette"
              aria-label="Expand palette"
              className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ── Canvas ──────────────────────────────────────────────────────── */}
        <div className="flex-1 relative" ref={wrapperRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {/* Run result overlay */}
          {runOpen && (
            <div className="absolute bottom-4 left-4 right-4 z-40 max-h-80 overflow-auto rounded-xl border bg-background shadow-2xl">
              <div className="flex items-center justify-between px-4 py-2 border-b">
                <span className="text-sm font-semibold">Test Run</span>
                <button onClick={() => setRunOpen(false)} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <Label className="text-xs">Input JSON</Label>
                  <Textarea
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                    rows={3}
                    className="font-mono text-xs"
                    placeholder='{"lead": {"id": 123}}'
                  />
                </div>
                <Button size="sm" onClick={run} disabled={running}>
                  {running ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Running…</> : <><Play className="h-4 w-4 mr-1" /> Run</>}
                </Button>
                {runResult && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={runResult.status === "completed" ? "default" : "destructive"}>{runResult.status}</Badge>
                      <span className="text-xs text-muted-foreground">{runResult.steps?.length ?? 0} steps</span>
                    </div>
                    {runResult.error && <div className="text-xs text-destructive">{runResult.error}</div>}
                    <pre className="text-[10px] bg-muted rounded p-2 overflow-auto max-h-32 mt-1">
                      {JSON.stringify(runResult, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Config panel ─────────────────────────────────────────────────── */}
        {configOpen ? (
          <div className="w-80 border-l bg-background overflow-y-auto relative">
            <div className="sticky top-0 z-10 flex items-center justify-end bg-background/95 backdrop-blur px-2 py-1 border-b">
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                title="Collapse panel"
                aria-label="Collapse panel"
                className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground"
              >
                <ChevronsRight className="h-4 w-4" />
              </button>
            </div>
            {!selected ? (
              <div className="p-4 text-sm text-muted-foreground">
                <div className="font-medium mb-1 text-foreground">No block selected</div>
                <p className="text-xs">Click a block on the canvas to configure it, or pick a starter flow from the left panel.</p>
                <Separator className="my-3" />
                <div className="text-xs space-y-1">
                  <div><kbd className="font-mono bg-muted px-1 rounded">Backspace</kbd> removes selected block</div>
                  <div><kbd className="font-mono bg-muted px-1 rounded">Drag</kbd> from bottom port to connect</div>
                  <div><kbd className="font-mono bg-muted px-1 rounded">Scroll</kbd> to zoom, <kbd className="font-mono bg-muted px-1 rounded">Space+drag</kbd> to pan</div>
                </div>
                <Separator className="my-3" />
                <div className="space-y-2">
                  <div><Label className="text-xs">Description</Label><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
                  <div><Label className="text-xs">Tags (comma)</Label><Input value={tags.join(", ")} onChange={(e) => setTags(e.target.value.split(",").map((t) => t.trim()).filter(Boolean))} /></div>
                </div>
              </div>
            ) : (
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const Icon = getLucide(selectedDef?.icon ?? "Box");
                      const cc = selectedDef?.color ?? catColor(selectedDef?.category);
                      return (
                        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-sm ${cc}`}>
                          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                        </span>
                      );
                    })()}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{selectedDef?.category}</div>
                      <div className="font-semibold text-sm">{selectedDef?.label ?? selected.data?.nodeType}</div>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={deleteSelected}><Trash2 className="h-4 w-4" /></Button>
                </div>
                <p className="text-xs text-muted-foreground">{selectedDef?.description}</p>
                <Separator />
                <div>
                  <Label className="text-xs">Block label</Label>
                  <Input value={selected.data?.label ?? ""} onChange={(e) => updateLabel(e.target.value)} />
                </div>
                {selectedDef?.params.map((p) => (
                  <ParamField key={p.key} spec={p} value={selected.data?.params?.[p.key]} onChange={(v) => updateParam(p.key, v)} />
                ))}
                {Array.isArray(selectedDef?.outputs) && (
                  <div className="text-xs">
                    <Label className="text-xs">Output branches</Label>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {selectedDef!.outputs.map((o) => <Badge key={String(o)} variant="outline">{String(o)}</Badge>)}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Set the edge's source-handle to one of these names to route on that branch.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="w-8 border-l bg-muted/20 flex flex-col items-center pt-2">
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              title="Expand panel"
              aria-label="Expand panel"
              className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ParamField ──────────────────────────────────────────────────────────────
function ParamField({ spec, value, onChange }: { spec: NodeParamSpec; value: any; onChange: (v: any) => void }) {
  const id = `param-${spec.key}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs flex items-center gap-1">
        {spec.label}
        {spec.required && <span className="text-destructive">*</span>}
      </Label>
      {spec.type === "boolean" ? (
        <div className="flex items-center gap-2">
          <Switch id={id} checked={!!value} onCheckedChange={onChange} />
          <span className="text-xs text-muted-foreground">{value ? "true" : "false"}</span>
        </div>
      ) : spec.type === "select" && spec.options ? (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger id={id} className="h-8 text-xs"><SelectValue placeholder="Select…" /></SelectTrigger>
          <SelectContent>
            {spec.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : spec.type === "text" || spec.type === "json" || spec.type === "code" ? (
        <Textarea
          id={id}
          rows={spec.type === "code" ? 6 : 3}
          className="font-mono text-xs"
          value={typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2)}
          placeholder={spec.placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            if (spec.type === "json") {
              try { onChange(JSON.parse(raw)); } catch { onChange(raw); }
            } else {
              onChange(raw);
            }
          }}
        />
      ) : (
        <Input
          id={id}
          type={spec.type === "number" ? "number" : "text"}
          className="text-xs h-8"
          value={value ?? ""}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(spec.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )}
      {spec.help && <p className="text-[10px] text-muted-foreground">{spec.help}</p>}
    </div>
  );
}
