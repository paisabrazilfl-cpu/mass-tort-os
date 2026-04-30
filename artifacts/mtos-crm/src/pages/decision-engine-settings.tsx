import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Plus, Pencil, Check, X, BarChart2 } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

const CHANNELS = ["paid", "organic", "referral", "call center", "web", "TV", "radio", "other"] as const;
type Channel = (typeof CHANNELS)[number];

interface Settings {
  default_attorney_hourly_cost: number;
  default_hours_per_lead: number;
  convex_ratio_threshold: number;
  concave_ratio_threshold: number;
  concentration_warning_pct: number;
  ruin_auto_flag: boolean;
}

interface Source {
  id: number;
  name: string;
  channel: string;
  cost_per_lead: string | null;
  historical_qualified_rate: string | null;
  historical_retained_rate: string | null;
  active: boolean;
}

interface EditState {
  name: string;
  channel: string;
  cost_per_lead: string;
  historical_qualified_rate: string;
  historical_retained_rate: string;
}

function fmtRate(v: string | null) {
  if (!v) return "—";
  const n = Number(v);
  return isNaN(n) ? "—" : `${(n * 100).toFixed(0)}%`;
}

function fmtCpl(v: string | null) {
  if (!v) return "—";
  const n = Number(v);
  return isNaN(n) ? "—" : `$${n.toFixed(2)}`;
}

export default function DecisionEngineSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [newSource, setNewSource] = useState<EditState>({ name: "", channel: "other", cost_per_lead: "", historical_qualified_rate: "", historical_retained_rate: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState>({ name: "", channel: "other", cost_per_lead: "", historical_qualified_rate: "", historical_retained_rate: "" });

  const { data: settings } = useQuery<Settings>({
    queryKey: ["decision-engine", "settings"],
    queryFn: async () => {
      const res = await apiFetchRaw("/api/decision-engine/settings");
      if (!res.ok) throw new Error("settings failed");
      return res.json();
    },
  });

  const { data: sources = [] } = useQuery<Source[]>({
    queryKey: ["lead-sources"],
    queryFn: async () => {
      const res = await apiFetchRaw("/api/lead-sources");
      if (!res.ok) throw new Error("sources failed");
      return res.json();
    },
  });

  useEffect(() => { if (settings) setForm({ ...settings }); }, [settings]);

  const saveSettings = useMutation({
    mutationFn: async (body: Settings) => {
      const res = await apiFetchRaw("/api/decision-engine/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (updated: Settings) => {
      setForm(updated);
      qc.invalidateQueries({ queryKey: ["decision-engine"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });

  const addSource = useMutation({
    mutationFn: async (body: any) => {
      const res = await apiFetchRaw("/api/lead-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead-sources"] });
      setNewSource({ name: "", channel: "other", cost_per_lead: "", historical_qualified_rate: "", historical_retained_rate: "" });
      toast({ title: "Lead source added" });
    },
    onError: (e: any) => toast({ title: "Add failed", description: e?.message, variant: "destructive" }),
  });

  const updateSource = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => {
      const res = await apiFetchRaw(`/api/lead-sources/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead-sources"] });
      setEditingId(null);
      toast({ title: "Source updated" });
    },
    onError: (e: any) => toast({ title: "Update failed", description: e?.message, variant: "destructive" }),
  });

  const deleteSource = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetchRaw(`/api/lead-sources/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lead-sources"] }); toast({ title: "Source removed" }); },
  });

  function startEdit(s: Source) {
    setEditingId(s.id);
    setEditState({
      name: s.name,
      channel: s.channel,
      cost_per_lead: s.cost_per_lead ?? "",
      historical_qualified_rate: s.historical_qualified_rate ?? "",
      historical_retained_rate: s.historical_retained_rate ?? "",
    });
  }

  function commitEdit(id: number) {
    updateSource.mutate({
      id,
      body: {
        name: editState.name,
        channel: editState.channel || "other",
        cost_per_lead: editState.cost_per_lead ? Number(editState.cost_per_lead) : null,
        historical_qualified_rate: editState.historical_qualified_rate ? Number(editState.historical_qualified_rate) : null,
        historical_retained_rate: editState.historical_retained_rate ? Number(editState.historical_retained_rate) : null,
      },
    });
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl" data-testid="page-decision-engine-settings">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Decision Engine Settings</h1>
          <p className="text-muted-foreground text-sm">Calibrate thresholds and lead-source economics</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/decision-engine">
            <BarChart2 className="w-4 h-4 mr-2" />
            View portfolio
          </Link>
        </Button>
      </div>

      {/* Global thresholds */}
      <Card>
        <CardHeader>
          <CardTitle>Global thresholds</CardTitle>
          <CardDescription>Used to classify leads as convex / neutral / concave</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          {form && (
            <>
              <div>
                <Label>Default attorney hourly cost ($)</Label>
                <Input type="number" value={form.default_attorney_hourly_cost} onChange={e => setForm({ ...form, default_attorney_hourly_cost: Number(e.target.value) })} data-testid="input-hourly-cost" />
              </div>
              <div>
                <Label>Default hours per lead</Label>
                <Input type="number" value={form.default_hours_per_lead} onChange={e => setForm({ ...form, default_hours_per_lead: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Convex ratio threshold (≥)</Label>
                <Input type="number" step="0.1" value={form.convex_ratio_threshold} onChange={e => setForm({ ...form, convex_ratio_threshold: Number(e.target.value) })} data-testid="input-convex-threshold" />
              </div>
              <div>
                <Label>Concave ratio threshold (&lt;)</Label>
                <Input type="number" step="0.1" value={form.concave_ratio_threshold} onChange={e => setForm({ ...form, concave_ratio_threshold: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Concentration warning (% of spend)</Label>
                <Input type="number" value={form.concentration_warning_pct} onChange={e => setForm({ ...form, concentration_warning_pct: Number(e.target.value) })} />
              </div>
              <div className="flex items-center gap-3 pt-6">
                <Switch
                  checked={!!form.ruin_auto_flag}
                  onCheckedChange={v => setForm({ ...form, ruin_auto_flag: v })}
                  id="auto-flag"
                  data-testid="switch-ruin-auto-flag"
                />
                <Label htmlFor="auto-flag">Auto-route ruin-flag leads to review queue</Label>
              </div>
              <div className="col-span-2">
                <Button onClick={() => saveSettings.mutate(form)} disabled={saveSettings.isPending} data-testid="button-save-settings">
                  {saveSettings.isPending ? "Saving…" : "Save settings"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Lead sources */}
      <Card>
        <CardHeader>
          <CardTitle>Lead sources</CardTitle>
          <CardDescription>Cost-per-lead and historical conversion rates feed the convexity calculation</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>CPL</TableHead>
                <TableHead>Qualified rate</TableHead>
                <TableHead>Retained rate</TableHead>
                <TableHead className="pr-4 w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    No lead sources yet — add one below.
                  </TableCell>
                </TableRow>
              )}

              {sources.map(s => (
                <TableRow key={s.id}>
                  {editingId === s.id ? (
                    <>
                      <TableCell className="pl-6">
                        <Input value={editState.name} onChange={e => setEditState({ ...editState, name: e.target.value })} className="h-8" />
                      </TableCell>
                      <TableCell>
                        <Select value={editState.channel} onValueChange={v => setEditState({ ...editState, channel: v })}>
                          <SelectTrigger className="h-8 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CHANNELS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input type="number" value={editState.cost_per_lead} onChange={e => setEditState({ ...editState, cost_per_lead: e.target.value })} placeholder="CPL" className="h-8 w-24" />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" value={editState.historical_qualified_rate} onChange={e => setEditState({ ...editState, historical_qualified_rate: e.target.value })} placeholder="0.00–1.00" className="h-8 w-24" />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" value={editState.historical_retained_rate} onChange={e => setEditState({ ...editState, historical_retained_rate: e.target.value })} placeholder="0.00–1.00" className="h-8 w-24" />
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => commitEdit(s.id)} disabled={!editState.name || updateSource.isPending} data-testid={`button-save-source-${s.id}`}>
                            <Check className="w-4 h-4 text-green-600" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            <X className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-medium pl-6">{s.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">{s.channel}</Badge>
                      </TableCell>
                      <TableCell>{fmtCpl(s.cost_per_lead)}</TableCell>
                      <TableCell>{fmtRate(s.historical_qualified_rate)}</TableCell>
                      <TableCell>{fmtRate(s.historical_retained_rate)}</TableCell>
                      <TableCell className="pr-4">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => startEdit(s)} data-testid={`button-edit-source-${s.id}`}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteSource.mutate(s.id)} data-testid={`button-delete-source-${s.id}`}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}

              {/* Add-new row */}
              <TableRow className="bg-muted/30">
                <TableCell className="pl-6">
                  <Input
                    placeholder="Source name"
                    value={newSource.name}
                    onChange={e => setNewSource({ ...newSource, name: e.target.value })}
                    data-testid="input-new-source-name"
                    className="h-8"
                  />
                </TableCell>
                <TableCell>
                  <Select value={newSource.channel} onValueChange={v => setNewSource({ ...newSource, channel: v })}>
                    <SelectTrigger className="h-8 w-32" data-testid="select-new-source-channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNELS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input type="number" placeholder="CPL" value={newSource.cost_per_lead} onChange={e => setNewSource({ ...newSource, cost_per_lead: e.target.value })} className="h-8 w-24" />
                </TableCell>
                <TableCell>
                  <Input type="number" step="0.01" placeholder="0.00–1.00" value={newSource.historical_qualified_rate} onChange={e => setNewSource({ ...newSource, historical_qualified_rate: e.target.value })} className="h-8 w-24" />
                </TableCell>
                <TableCell>
                  <Input type="number" step="0.01" placeholder="0.00–1.00" value={newSource.historical_retained_rate} onChange={e => setNewSource({ ...newSource, historical_retained_rate: e.target.value })} className="h-8 w-24" />
                </TableCell>
                <TableCell className="pr-4">
                  <Button
                    size="sm"
                    onClick={() => addSource.mutate({
                      name: newSource.name,
                      channel: newSource.channel || "other",
                      cost_per_lead: newSource.cost_per_lead ? Number(newSource.cost_per_lead) : null,
                      historical_qualified_rate: newSource.historical_qualified_rate ? Number(newSource.historical_qualified_rate) : null,
                      historical_retained_rate: newSource.historical_retained_rate ? Number(newSource.historical_retained_rate) : null,
                    })}
                    disabled={!newSource.name || addSource.isPending}
                    data-testid="button-add-source"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
