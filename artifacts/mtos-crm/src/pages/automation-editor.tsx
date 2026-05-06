import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import ReactFlow, {
  Background, Controls, MiniMap, addEdge,
  applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection,
  ReactFlowProvider, useReactFlow, MarkerType,
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
import { ArrowLeft, Save, Play, Download, Trash2, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Sparkles, X, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { apiFetchRaw } from "@/lib/api-fetch";
import { getLucide } from "@/lib/lucide-icon";

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
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [catalog, setCatalog] = useState<NodeDef[]>([]);
  const [openCat, setOpenCat] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState("{}");
  const [running, setRunning] = useState(false);
  // AI Assistant drawer state
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
        const g = wf.graph ?? { nodes: [], edges: [] };
        // Server stores the catalog node type on `n.type` (e.g. "trigger.manual").
        // ReactFlow's `type` field, however, must point to a registered renderer
        // — we use the built-in "default" everywhere. Translate by stashing the
        // catalog type on `data.nodeType` and resetting the rf-level type so
        // saved graphs round-trip cleanly through the editor.
        setNodes((g.nodes ?? []).map((n: any) => ({
          ...n,
          type: "default",
          position: n.position ?? { x: 100, y: 100 },
          style: n.style ?? { borderRadius: 8, border: "1px solid #334155", padding: 0, width: 200 },
          data: { ...(n.data ?? {}), nodeType: n.data?.nodeType ?? n.type, params: n.data?.params ?? {} },
        })));
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

  const catalogByType = useMemo(() => Object.fromEntries(catalog.map((c) => [c.type, c])), [catalog]);
  const grouped = useMemo(() => {
    const m: Record<string, NodeDef[]> = {};
    catalog.forEach((d) => { (m[d.category] ??= []).push(d); });
    return m;
  }, [catalog]);

  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es)), []);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: uid("e"), markerEnd: { type: MarkerType.ArrowClosed } }, es)), []);
  // The node passed to onNodeClick is the *rendered* one (whose data.label has
  // been replaced with a JSX element for the canvas badge). Look the original
  // node up from state so the config panel sees the plain string label and
  // raw params, not React elements.
  const onNodeClick = useCallback((_: any, n: Node) => {
    setSelected((_prev) => null);
    setNodes((curr) => {
      const original = curr.find((x) => x.id === n.id) ?? n;
      setSelected(original);
      return curr;
    });
  }, []);
  const onPaneClick = useCallback(() => setSelected(null), []);

  function addNode(def: NodeDef) {
    const center = wrapperRef.current?.getBoundingClientRect();
    const pos = flow.project({ x: (center?.width ?? 600) / 2 - 100, y: 100 });
    const n: Node = {
      id: uid(),
      type: "default",
      position: pos,
      data: {
        label: def.label,
        nodeType: def.type,
        params: Object.fromEntries(def.params.map((p) => [p.key, p.default ?? ""])),
      },
    };
    // We use the default reactflow node type but render a custom inner label.
    n.style = { borderRadius: 8, border: "1px solid #334155", padding: 0, width: 200 };
    setNodes((ns) => [...ns, decorateNode(n, def)]);
  }

  function decorateNode(n: Node, def?: NodeDef): Node {
    const d = def ?? catalogByType[n.data?.nodeType];
    if (!d) return n;
    return {
      ...n,
      // Expose node type on the runtime node so executor can use it.
      // We mirror it as the reactflow-level `type` so saved graphs round-trip.
      data: { ...n.data, label: n.data?.label ?? d.label, nodeType: d.type },
    };
  }

  function deleteSelected() {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected.id));
    setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
    setSelected(null);
  }

  function updateParam(key: string, value: any) {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => n.id === selected.id ? { ...n, data: { ...n.data, params: { ...(n.data?.params ?? {}), [key]: value } } } : n));
    setSelected((s) => s ? { ...s, data: { ...s.data, params: { ...(s.data?.params ?? {}), [key]: value } } } : s);
  }

  function updateLabel(label: string) {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => n.id === selected.id ? { ...n, data: { ...n.data, label } } : n));
    setSelected((s) => s ? { ...s, data: { ...s.data, label } } : s);
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

  async function save() {
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
      // Save first so the executor sees latest graph.
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
    if (trimmed.length < 3) {
      toast({ title: "Type a longer prompt", variant: "destructive" });
      return;
    }
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
        const detail = Array.isArray(issues) ? issues.join("\n• ") : (data?.message ?? "Assistant failed");
        setAssistError(detail);
        return;
      }
      setAssistResult({
        explanation: data.explanation ?? "",
        graph: data.graph,
        mode: data.mode ?? assistMode,
      });
    } catch (e: any) {
      setAssistError(e?.message ?? String(e));
    } finally {
      setAssistLoading(false);
    }
  }

  function applyAssistResult() {
    if (!assistResult) return;
    const proposed = assistResult.graph;
    // Defensive client-side guard: even though /assist already validated the
    // graph against the catalog, double-check here so a stale catalog cache
    // (e.g. after a server deploy) can't slip an unknown node onto the
    // canvas. We also ensure every edge points at a node we know about.
    const ids = new Set(proposed.nodes.map((n: any) => n.id));
    const badNodes = proposed.nodes.filter((n: any) => !catalogByType[n.type]);
    const badEdges = proposed.edges.filter((e: any) => !ids.has(e.source) || !ids.has(e.target));
    if (badNodes.length > 0 || badEdges.length > 0) {
      const detail = [
        ...badNodes.map((n: any) => `unknown node type "${n.type}"`),
        ...badEdges.map((e: any) => `dangling edge ${e.id}`),
      ].join("; ");
      toast({ title: "Refused to apply proposal", description: detail, variant: "destructive" });
      return;
    }
    // Map the proposed catalog graph onto ReactFlow nodes the same way the
    // initial-load path does — keeping `data.nodeType` so the editor's per-
    // node config panel works on the new nodes.
    const newNodes = proposed.nodes.map((n) => decorateNodeFromCatalog(n));
    const newEdges = proposed.edges.map((e) => ({
      ...e,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
    if (assistResult.mode === "replace") {
      setNodes(newNodes); setEdges(newEdges);
    } else {
      // Patch: append new nodes/edges, dedupe by id (incoming wins).
      const incomingIds = new Set(newNodes.map((n) => n.id));
      setNodes((curr) => [...curr.filter((n) => !incomingIds.has(n.id)), ...newNodes]);
      const incomingEdgeIds = new Set(newEdges.map((e) => e.id));
      setEdges((curr) => [...curr.filter((e) => !incomingEdgeIds.has(e.id)), ...newEdges]);
    }
    toast({ title: "Workflow updated", description: assistResult.mode === "replace" ? "Graph replaced" : "Patch merged" });
    setAssistResult(null); setAssistOpen(false); setAssistPrompt("");
  }

  // Decorate a catalog-shaped node {id,type,position,data:{label,params}} into
  // the ReactFlow node shape the editor uses (mirrors the initial-load logic).
  function decorateNodeFromCatalog(n: any): Node {
    const def = catalogByType[n.type];
    return {
      id: n.id,
      position: n.position ?? { x: 100, y: 100 },
      type: "default",
      data: {
        nodeType: n.type,
        label: n.data?.label ?? def?.label ?? n.type,
        params: n.data?.params ?? {},
      },
      style: def
        ? { borderLeft: `4px solid var(--accent, #6366f1)`, paddingLeft: 8 }
        : undefined,
    } as Node;
  }

  function exportLocal() {
    const blob = new Blob([JSON.stringify({ name, description, tags, graph: buildGraphForSave() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/\W+/g, "_") || "workflow"}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  // Render
  const selectedDef = selected ? catalogByType[selected.data?.nodeType] : undefined;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Toolbar */}
      <div className="border-b bg-background flex items-center gap-2 px-4 py-2">
        <Button variant="ghost" size="sm" asChild><Link href="/automations"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
        <Input className="max-w-md" value={name} onChange={(e) => setName(e.target.value)} placeholder="Workflow name" />
        <div className="flex items-center gap-2 ml-2">
          <Switch checked={enabled} onCheckedChange={setEnabled} id="enabled" />
          <Label htmlFor="enabled" className="text-xs">Enabled</Label>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAssistOpen(true)} data-testid="button-ai-assist"><Sparkles className="h-4 w-4 mr-1" /> AI Assist</Button>
          <Button size="sm" variant="outline" onClick={exportLocal}><Download className="h-4 w-4 mr-1" /> Export</Button>
          <Button size="sm" variant="outline" onClick={() => setRunOpen((v) => !v)}><Play className="h-4 w-4 mr-1" /> Run</Button>
          <Button size="sm" onClick={save} disabled={saving}><Save className="h-4 w-4 mr-1" /> {saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>

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
        {/* Node palette */}
        {paletteOpen ? (
        <div className="w-64 border-r bg-muted/20 overflow-y-auto relative">
          <div className="p-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Drag a node into the canvas</span>
            <button
              type="button"
              onClick={() => setPaletteOpen(false)}
              title="Collapse palette"
              aria-label="Collapse palette"
              className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
          </div>
          {Object.entries(grouped).map(([cat, list]) => (
            <div key={cat} className="border-t">
              <button
                onClick={() => setOpenCat((s) => ({ ...s, [cat]: !s[cat] }))}
                className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium hover:bg-muted/40"
              >
                <span>{cat}</span>
                {openCat[cat] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {openCat[cat] && (
                <div className="pb-1">
                  {list.map((d) => {
                    const Icon = getLucide(d.icon);
                    return (
                      <button
                        key={d.type}
                        onClick={() => addNode(d)}
                        title={d.description}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
                      >
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-white ${d.color}`}>
                          <Icon className="h-3 w-3" />
                        </span>
                        <span className="truncate">{d.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
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

        {/* Canvas */}
        <div className="flex-1 relative" ref={wrapperRef}>
          <ReactFlow
            nodes={nodes.map((n) => {
              const def = catalogByType[n.data?.nodeType];
              const colorClass = def?.color ?? "bg-slate-600";
              const Icon = getLucide(def?.icon);
              return {
                ...n,
                data: {
                  ...n.data,
                  label: (
                    <div className="text-left">
                      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white px-2 py-0.5 ${colorClass} rounded-t`}>
                        <Icon className="h-3 w-3" aria-hidden="true" />
                        <span>{def?.category ?? "node"}</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        <span>{n.data?.label ?? def?.label ?? n.data?.nodeType}</span>
                      </div>
                    </div>
                  ),
                },
              };
            })}
            edges={edges}
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
        </div>

        {/* Config panel */}
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
              <div className="font-medium mb-1">No node selected</div>
              <p className="text-xs">Click a node to edit its parameters. Add nodes from the left palette. Connect by dragging from one node's bottom dot to another node's top dot.</p>
              <Separator className="my-3" />
              <div className="text-xs space-y-1">
                <div><kbd>Backspace/Delete</kbd> removes selected nodes</div>
                <div><kbd>Drag</kbd> from bottom port to connect</div>
                <div><kbd>Scroll</kbd> to zoom, <kbd>Space+drag</kbd> to pan</div>
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
                    const Icon = getLucide(selectedDef?.icon);
                    return (
                      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-white ${selectedDef?.color ?? "bg-slate-600"}`}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    );
                  })()}
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{selectedDef?.category}</div>
                    <div className="font-semibold">{selectedDef?.label ?? selected.data?.nodeType}</div>
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={deleteSelected}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <p className="text-xs text-muted-foreground">{selectedDef?.description}</p>
              <Separator />
              <div>
                <Label className="text-xs">Node label</Label>
                <Input value={selected.data?.label ?? ""} onChange={(e) => updateLabel(e.target.value)} />
              </div>
              {selectedDef?.params.map((p) => (
                <ParamField key={p.key} spec={p} value={selected.data?.params?.[p.key]} onChange={(v) => updateParam(p.key, v)} />
              ))}
              {Array.isArray(selectedDef?.outputs) && (
                <div className="text-xs">
                  <Label className="text-xs">Outputs</Label>
                  <div className="flex gap-1 mt-1 flex-wrap">{selectedDef!.outputs.map((o) => <Badge key={String(o)} variant="outline">{String(o)}</Badge>)}</div>
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

      {/* Run drawer */}
      {runOpen && (
        <div className="border-t bg-background max-h-[40vh] overflow-y-auto">
          <div className="p-3 flex items-start gap-3">
            <div className="flex-1">
              <Label className="text-xs">Input (JSON, available as <code>input</code> in nodes)</Label>
              <Textarea rows={3} className="font-mono text-xs" value={runInput} onChange={(e) => setRunInput(e.target.value)} />
            </div>
            <Button size="sm" onClick={run} disabled={running}><Play className="h-4 w-4 mr-1" /> {running ? "Running…" : "Execute"}</Button>
          </div>
          {runResult && (
            <div className="px-3 pb-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <Badge variant={runResult.status === "completed" ? "default" : "destructive"}>{runResult.status}</Badge>
                <span className="text-muted-foreground">run #{runResult.runId} · {runResult.steps?.length ?? 0} steps</span>
                {runResult.error && <span className="text-destructive">{runResult.error}</span>}
              </div>
              <Tabs defaultValue="steps">
                <TabsList>
                  <TabsTrigger value="steps">Steps</TabsTrigger>
                  <TabsTrigger value="output">Output</TabsTrigger>
                </TabsList>
                <TabsContent value="steps">
                  <div className="space-y-1">
                    {(runResult.steps ?? []).map((s: any, i: number) => (
                      <div key={i} className="text-xs border rounded p-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={s.status === "ok" ? "default" : "destructive"}>{s.status}</Badge>
                          <span className="font-mono">{s.type}</span>
                          {s.label && <span className="text-muted-foreground">{s.label}</span>}
                          {s.branch && <Badge variant="outline">→ {s.branch}</Badge>}
                        </div>
                        {s.error && <pre className="mt-1 text-destructive whitespace-pre-wrap">{s.error}</pre>}
                        {s.output !== undefined && <pre className="mt-1 text-[11px] bg-muted/40 p-1 rounded overflow-x-auto">{JSON.stringify(s.output, null, 2)}</pre>}
                      </div>
                    ))}
                  </div>
                </TabsContent>
                <TabsContent value="output">
                  <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(runResult.output, null, 2)}</pre>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ParamField({ spec, value, onChange }: { spec: NodeParamSpec; value: any; onChange: (v: any) => void }) {
  const common = (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{spec.label}{spec.required && <span className="text-destructive ml-0.5">*</span>}</Label>
    </div>
  );
  if (spec.type === "boolean") {
    return (
      <div className="flex items-center justify-between">
        <Label className="text-xs">{spec.label}</Label>
        <Switch checked={!!value} onCheckedChange={onChange} />
      </div>
    );
  }
  if (spec.type === "select") {
    return (
      <div>{common}
        <Select value={String(value ?? spec.default ?? "")} onValueChange={onChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{spec.options?.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
        </Select>
        {spec.help && <p className="text-[10px] text-muted-foreground mt-0.5">{spec.help}</p>}
      </div>
    );
  }
  if (spec.type === "number") {
    return (
      <div>{common}<Input type="number" value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} placeholder={spec.placeholder} /></div>
    );
  }
  if (spec.type === "text" || spec.type === "code") {
    return (
      <div>{common}
        <Textarea rows={spec.type === "code" ? 6 : 3} className={spec.type === "code" ? "font-mono text-xs" : "text-xs"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />
        {spec.help && <p className="text-[10px] text-muted-foreground mt-0.5">{spec.help}</p>}
      </div>
    );
  }
  if (spec.type === "json") {
    const str = typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
    return (
      <div>{common}
        <Textarea rows={4} className="font-mono text-xs" value={str} onChange={(e) => {
          const t = e.target.value;
          try { onChange(JSON.parse(t)); } catch { onChange(t); }
        }} placeholder={spec.placeholder} />
        <p className="text-[10px] text-muted-foreground mt-0.5">JSON. Invalid JSON is kept as a raw string until corrected.</p>
      </div>
    );
  }
  return (
    <div>{common}<Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />{spec.help && <p className="text-[10px] text-muted-foreground mt-0.5">{spec.help}</p>}</div>
  );
}
