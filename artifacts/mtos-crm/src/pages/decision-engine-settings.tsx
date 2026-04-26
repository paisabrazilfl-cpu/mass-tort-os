import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Plus } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface Settings {
  default_attorney_hourly_cost: number;
  default_hours_per_lead: number;
  convex_ratio_threshold: number;
  concave_ratio_threshold: number;
  concentration_warning_pct: number;
  ruin_auto_flag?: boolean;
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

export default function DecisionEngineSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [newSource, setNewSource] = useState({ name: "", channel: "other", cost_per_lead: "", historical_qualified_rate: "", historical_retained_rate: "" });

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

  useEffect(() => { if (settings) setForm(settings); }, [settings]);

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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["decision-engine"] }); toast({ title: "Settings saved" }); },
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
      toast({ title: "Source added" });
    },
    onError: (e: any) => toast({ title: "Add failed", description: e?.message, variant: "destructive" }),
  });

  const deleteSource = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetchRaw(`/api/lead-sources/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lead-sources"] }); toast({ title: "Source removed" }); },
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-decision-engine-settings">
      <div>
        <h1 className="text-2xl font-bold">Decision Engine Settings</h1>
        <p className="text-muted-foreground text-sm">Calibrate thresholds and lead-source economics</p>
      </div>

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
                <Switch checked={!!form.ruin_auto_flag} onCheckedChange={v => setForm({ ...form, ruin_auto_flag: v })} id="auto-flag" />
                <Label htmlFor="auto-flag">Auto-route ruin-flag leads to review queue</Label>
              </div>
              <div className="col-span-2">
                <Button onClick={() => saveSettings.mutate(form)} disabled={saveSettings.isPending} data-testid="button-save-settings">
                  Save settings
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lead sources</CardTitle>
          <CardDescription>Cost-per-lead and historical conversion rates feed the convexity calculation</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>CPL</TableHead>
                <TableHead>Qualified rate</TableHead>
                <TableHead>Retained rate</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map(s => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.channel}</TableCell>
                  <TableCell>${s.cost_per_lead || "—"}</TableCell>
                  <TableCell>{s.historical_qualified_rate ? `${(Number(s.historical_qualified_rate) * 100).toFixed(0)}%` : "—"}</TableCell>
                  <TableCell>{s.historical_retained_rate ? `${(Number(s.historical_retained_rate) * 100).toFixed(0)}%` : "—"}</TableCell>
                  <TableCell><Button size="sm" variant="ghost" onClick={() => deleteSource.mutate(s.id)} data-testid={`button-delete-source-${s.id}`}><Trash2 className="w-4 h-4" /></Button></TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell><Input placeholder="Source name" value={newSource.name} onChange={e => setNewSource({ ...newSource, name: e.target.value })} data-testid="input-new-source-name" /></TableCell>
                <TableCell><Input placeholder="Channel" value={newSource.channel} onChange={e => setNewSource({ ...newSource, channel: e.target.value })} /></TableCell>
                <TableCell><Input type="number" placeholder="CPL" value={newSource.cost_per_lead} onChange={e => setNewSource({ ...newSource, cost_per_lead: e.target.value })} /></TableCell>
                <TableCell><Input type="number" step="0.01" placeholder="0.00 - 1.00" value={newSource.historical_qualified_rate} onChange={e => setNewSource({ ...newSource, historical_qualified_rate: e.target.value })} /></TableCell>
                <TableCell><Input type="number" step="0.01" placeholder="0.00 - 1.00" value={newSource.historical_retained_rate} onChange={e => setNewSource({ ...newSource, historical_retained_rate: e.target.value })} /></TableCell>
                <TableCell>
                  <Button size="sm" onClick={() => addSource.mutate({
                    name: newSource.name,
                    channel: newSource.channel || "other",
                    cost_per_lead: newSource.cost_per_lead ? Number(newSource.cost_per_lead) : null,
                    historical_qualified_rate: newSource.historical_qualified_rate ? Number(newSource.historical_qualified_rate) : null,
                    historical_retained_rate: newSource.historical_retained_rate ? Number(newSource.historical_retained_rate) : null,
                  })} disabled={!newSource.name || addSource.isPending} data-testid="button-add-source">
                    <Plus className="w-4 h-4" />
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
