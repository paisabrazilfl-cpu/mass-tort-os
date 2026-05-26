import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  Globe, Loader2, Settings2, Search, Zap, Radio,
} from "lucide-react";

interface PortalConfig {
  id: number;
  tort_type: string;
  portal_enabled: boolean;
  brand_name: string | null;
  brand_color: string | null;
  logo_url: string | null;
  updated_at: string;
}

interface SettingsResponse {
  tort_types: string[];
  configs: PortalConfig[];
}

interface DraftConfig {
  portal_enabled: boolean;
  brand_name: string;
  brand_color: string;
  logo_url: string;
}

function toLabel(tortType: string) {
  return tortType
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function emptyDraft(cfg?: PortalConfig, tortType?: string): DraftConfig {
  return {
    portal_enabled: cfg?.portal_enabled ?? false,
    brand_name: cfg?.brand_name ?? (tortType ? toLabel(tortType) + " Claims" : ""),
    brand_color: cfg?.brand_color ?? "#1e3a5f",
    logo_url: cfg?.logo_url ?? "",
  };
}

interface EditDialogProps {
  tortType: string;
  config: PortalConfig | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: (cfg: PortalConfig) => void;
}

function EditDialog({ tortType, config, open, onClose, onSaved }: EditDialogProps) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<DraftConfig>(() => emptyDraft(config, tortType));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(emptyDraft(config, tortType));
  }, [open, config, tortType]);

  const set = <K extends keyof DraftConfig>(key: K, val: DraftConfig[K]) =>
    setDraft(d => ({ ...d, [key]: val }));

  function quickFill() {
    setDraft(d => ({
      ...d,
      portal_enabled: true,
      brand_name: toLabel(tortType) + " Claims",
      brand_color: "#1e3a5f",
    }));
    toast({ title: "Auto-filled!", description: "Review and save when ready." });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        portal_enabled: draft.portal_enabled,
        brand_name: draft.brand_name || null,
        brand_color: draft.brand_color || null,
        logo_url: draft.logo_url || null,
      };

      const res = await apiFetchRaw(`/api/portal-settings/${encodeURIComponent(tortType)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }

      const saved = await res.json() as PortalConfig;
      onSaved(saved);
      toast({ title: "Saved!", description: `${toLabel(tortType)} portal updated.` });
      onClose();
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-blue-500" />
            {toLabel(tortType)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Quick fill */}
          {!config && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 flex items-start gap-3">
              <Zap className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-blue-800">New campaign</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  Never set up before. Hit Auto-Fill to get started in one click.
                </p>
              </div>
              <Button size="sm" variant="outline" className="flex-shrink-0 gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-100" onClick={quickFill}>
                <Zap className="h-3.5 w-3.5" /> Auto-Fill
              </Button>
            </div>
          )}

          {/* Portal on/off — the big switch */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="font-medium">Portal live</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Turn this on so claimants can access their portal for this campaign.
              </p>
            </div>
            <Switch
              checked={draft.portal_enabled}
              onCheckedChange={v => set("portal_enabled", v)}
            />
          </div>

          {/* Branding */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Branding</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Display name</Label>
                <Input
                  value={draft.brand_name}
                  onChange={e => set("brand_name", e.target.value)}
                  placeholder="e.g. Camp Lejeune Claims"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Brand color</Label>
                <div className="flex gap-1.5">
                  <Input
                    value={draft.brand_color}
                    onChange={e => set("brand_color", e.target.value)}
                    placeholder="#1e3a5f"
                    maxLength={7}
                    className="h-8 text-sm font-mono flex-1"
                  />
                  <input
                    type="color"
                    value={draft.brand_color || "#1e3a5f"}
                    onChange={e => set("brand_color", e.target.value)}
                    className="h-8 w-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Logo URL <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={draft.logo_url}
                onChange={e => set("logo_url", e.target.value)}
                placeholder="https://your-cdn.com/logo.png"
                className="h-8 text-sm"
              />
            </div>
          </div>

        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PortalSettingsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editTort, setEditTort] = useState<string | null>(null);
  const [togglingTort, setTogglingTort] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/portal-settings");
      if (res.ok) setData(await res.json() as SettingsResponse);
    } catch {
      toast({ title: "Failed to load portal settings", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  function handleSaved(saved: PortalConfig) {
    setData(prev => {
      if (!prev) return prev;
      const existing = prev.configs.find(c => c.tort_type === saved.tort_type);
      const configs = existing
        ? prev.configs.map(c => c.tort_type === saved.tort_type ? saved : c)
        : [...prev.configs, saved];
      const tort_types = prev.tort_types.includes(saved.tort_type)
        ? prev.tort_types
        : [...prev.tort_types, saved.tort_type].sort();
      return { tort_types, configs };
    });
  }

  async function handleToggle(tortType: string, enabled: boolean) {
    setTogglingTort(tortType);
    try {
      const existing = data?.configs.find(c => c.tort_type === tortType);
      const body: Record<string, unknown> = {
        portal_enabled: enabled,
        brand_name: existing?.brand_name ?? toLabel(tortType) + " Claims",
        brand_color: existing?.brand_color ?? "#1e3a5f",
        logo_url: existing?.logo_url ?? null,
      };
      const res = await apiFetchRaw(`/api/portal-settings/${encodeURIComponent(tortType)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json() as PortalConfig;
      handleSaved(saved);
      toast({
        title: enabled ? "Portal activated" : "Portal deactivated",
        description: toLabel(tortType),
      });
    } catch (err) {
      toast({ title: "Toggle failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setTogglingTort(null);
    }
  }

  const tort_types = data?.tort_types ?? [];
  const configs = data?.configs ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return tort_types;
    const q = search.toLowerCase();
    return tort_types.filter(t => t.toLowerCase().includes(q) || toLabel(t).toLowerCase().includes(q));
  }, [tort_types, search]);

  const liveCount = configs.filter(c => c.portal_enabled).length;
  const configuredCount = configs.length;

  const editConfig = editTort ? configs.find(c => c.tort_type === editTort) : undefined;

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4 space-y-4">
        <Skeleton className="h-24 w-full" />
        {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Portal Campaigns</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Turn on the claimant portal for each campaign. Claimants get a magic link after passing the background check.
        </p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold text-slate-800">{tort_types.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Total campaigns</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold text-green-600">{liveCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Live portals</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold text-slate-400">{tort_types.length - liveCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Off</p>
          </CardContent>
        </Card>
      </div>

      {/* How it works callout */}
      <div className="rounded-lg bg-slate-50 border p-4 flex gap-3">
        <Radio className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-slate-800">How it works</p>
          <p className="text-muted-foreground mt-0.5">
            When a claimant clears the background check, they automatically receive an email with a secure link to their portal — where they can upload documents and connect their medical records. Toggle any campaign on to go live.
          </p>
        </div>
      </div>

      {/* Search + table */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="pl-9"
          />
        </div>

        <Card>
          <div className="divide-y">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-2 bg-slate-50 rounded-t-lg">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Campaign</span>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center w-20">Status</span>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center w-16">Live</span>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider w-16"></span>
            </div>

            {filtered.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {search ? `No campaigns matching "${search}"` : "No campaigns yet."}
              </div>
            )}

            {filtered.map(t => {
              const cfg = configs.find(c => c.tort_type === t);
              const isLive = cfg?.portal_enabled ?? false;
              const isConfigured = !!cfg;
              const isToggling = togglingTort === t;

              return (
                <div key={t} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-3 hover:bg-slate-50/60 transition-colors">
                  {/* Name */}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{toLabel(t)}</p>
                    {cfg?.brand_name && cfg.brand_name !== toLabel(t) + " Claims" && (
                      <p className="text-xs text-muted-foreground truncate">{cfg.brand_name}</p>
                    )}
                  </div>

                  {/* Status badge */}
                  <div className="w-20 flex justify-center">
                    {isLive ? (
                      <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100 text-xs">Live</Badge>
                    ) : isConfigured ? (
                      <Badge variant="outline" className="text-slate-400 text-xs">Off</Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-500 border-amber-300 text-xs">New</Badge>
                    )}
                  </div>

                  {/* Toggle */}
                  <div className="w-16 flex justify-center">
                    {isToggling ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={isLive}
                        onCheckedChange={v => void handleToggle(t, v)}
                        aria-label={`Toggle portal for ${toLabel(t)}`}
                      />
                    )}
                  </div>

                  {/* Edit button */}
                  <div className="w-16 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-muted-foreground hover:text-slate-800"
                      onClick={() => setEditTort(t)}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Edit dialog */}
      {editTort && (
        <EditDialog
          tortType={editTort}
          config={editConfig}
          open={!!editTort}
          onClose={() => setEditTort(null)}
          onSaved={cfg => { handleSaved(cfg); setEditTort(null); }}
        />
      )}
    </div>
  );
}
