import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  Globe, Wifi, ChevronDown, ChevronUp, Loader2, Plus,
  CheckCircle2, AlertCircle, Key, Palette,
} from "lucide-react";

interface PortalConfig {
  id: number;
  tort_type: string;
  portal_enabled: boolean;
  brand_name: string | null;
  brand_color: string | null;
  logo_url: string | null;
  fasten_enabled: boolean;
  fasten_backend: string | null;
  fasten_api_url: string | null;
  has_fasten_api_key: boolean;
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
  fasten_enabled: boolean;
  fasten_backend: "onprem" | "connect";
  fasten_api_url: string;
  fasten_api_key: string;
}

function emptyDraft(cfg?: PortalConfig): DraftConfig {
  return {
    portal_enabled: cfg?.portal_enabled ?? false,
    brand_name: cfg?.brand_name ?? "",
    brand_color: cfg?.brand_color ?? "#1e3a5f",
    logo_url: cfg?.logo_url ?? "",
    fasten_enabled: cfg?.fasten_enabled ?? false,
    fasten_backend: (cfg?.fasten_backend as "onprem" | "connect") ?? "onprem",
    fasten_api_url: cfg?.fasten_api_url ?? "",
    fasten_api_key: "",
  };
}

interface TortCardProps {
  tortType: string;
  config: PortalConfig | undefined;
  onSaved: (cfg: PortalConfig) => void;
}

function TortCard({ tortType, config, onSaved }: TortCardProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftConfig>(() => emptyDraft(config));
  const [saving, setSaving] = useState(false);

  // Reset draft if parent config changes (e.g. after save).
  useEffect(() => {
    setDraft(emptyDraft(config));
  }, [config]);

  const set = <K extends keyof DraftConfig>(key: K, val: DraftConfig[K]) =>
    setDraft(d => ({ ...d, [key]: val }));

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        portal_enabled: draft.portal_enabled,
        brand_name: draft.brand_name || null,
        brand_color: draft.brand_color || null,
        logo_url: draft.logo_url || null,
        fasten_enabled: draft.fasten_enabled,
        fasten_backend: draft.fasten_backend,
        fasten_api_url: draft.fasten_api_url || null,
      };
      if (draft.fasten_api_key) body.fasten_api_key = draft.fasten_api_key;

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
      setDraft(d => ({ ...d, fasten_api_key: "" }));
      toast({ title: "Portal settings saved", description: `${tortType} config updated.` });
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const isConfigured = !!config;
  const isActive = config?.portal_enabled;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        className="cursor-pointer select-none py-3 px-4"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Globe className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <span className="text-sm font-semibold text-slate-800 truncate">{tortType}</span>
            {isActive && (
              <Badge className="bg-green-600 hover:bg-green-700 text-[10px] px-1.5 py-0">Active</Badge>
            )}
            {isConfigured && !isActive && (
              <Badge variant="outline" className="text-slate-400 text-[10px] px-1.5 py-0">Disabled</Badge>
            )}
            {!isConfigured && (
              <Badge variant="outline" className="text-amber-500 border-amber-300 text-[10px] px-1.5 py-0">
                Not configured
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {config?.fasten_enabled && (
              <Wifi className="h-3.5 w-3.5 text-blue-500" aria-label="Fasten Health enabled" />
            )}
            {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
          </div>
        </div>
      </CardHeader>

      {open && (
        <>
          <Separator />
          <CardContent className="pt-4 pb-4 space-y-5">
            {/* Portal on/off */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Portal enabled</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Master switch — disabling blocks all portal routes for this tort.
                </p>
              </div>
              <Switch
                checked={draft.portal_enabled}
                onCheckedChange={v => set("portal_enabled", v)}
              />
            </div>

            {/* Branding */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" /> Branding
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Brand name</Label>
                  <Input
                    value={draft.brand_name}
                    onChange={e => set("brand_name", e.target.value)}
                    placeholder="e.g. Lejeune Claims Team"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Brand color (hex)</Label>
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
                      title="Pick a color"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Logo URL</Label>
                <Input
                  value={draft.logo_url}
                  onChange={e => set("logo_url", e.target.value)}
                  placeholder="https://cdn.yourfirm.com/logo.png"
                  className="h-8 text-sm"
                />
              </div>
            </div>

            {/* Fasten Health */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Wifi className="h-3.5 w-3.5" /> Fasten Health (FHIR)
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Fasten enabled</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Let patients link their patient portal directly via FHIR OAuth.
                  </p>
                </div>
                <Switch
                  checked={draft.fasten_enabled}
                  onCheckedChange={v => set("fasten_enabled", v)}
                />
              </div>

              {draft.fasten_enabled && (
                <div className="space-y-3 pl-0">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Backend</Label>
                    <Select
                      value={draft.fasten_backend}
                      onValueChange={v => set("fasten_backend", v as "onprem" | "connect")}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="onprem">Self-hosted (fasten-onprem)</SelectItem>
                        <SelectItem value="connect">Fasten Connect (SaaS)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {draft.fasten_backend === "onprem" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Fasten instance URL</Label>
                      <Input
                        value={draft.fasten_api_url}
                        onChange={e => set("fasten_api_url", e.target.value)}
                        placeholder="https://fasten.yourfirm.com"
                        className="h-8 text-sm"
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1.5">
                      <Key className="h-3 w-3" />
                      API key
                      {config?.has_fasten_api_key && (
                        <span className="text-green-600 flex items-center gap-0.5 font-normal">
                          <CheckCircle2 className="h-3 w-3" /> Key saved
                        </span>
                      )}
                      {!config?.has_fasten_api_key && (
                        <span className="text-amber-500 flex items-center gap-0.5 font-normal">
                          <AlertCircle className="h-3 w-3" /> Not set
                        </span>
                      )}
                    </Label>
                    <Input
                      type="password"
                      value={draft.fasten_api_key}
                      onChange={e => set("fasten_api_key", e.target.value)}
                      placeholder={config?.has_fasten_api_key ? "Leave blank to keep existing key" : "Paste admin API key…"}
                      className="h-8 text-sm font-mono"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button onClick={() => void handleSave()} disabled={saving} size="sm" className="gap-1.5">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </CardContent>
        </>
      )}
    </Card>
  );
}

export default function PortalSettingsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [newTortType, setNewTortType] = useState("");
  const [addingNew, setAddingNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/portal-settings");
      if (res.ok) {
        setData(await res.json() as SettingsResponse);
      }
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

  function handleAddNew() {
    const t = newTortType.trim();
    if (!t) return;
    if (data?.tort_types.includes(t)) {
      toast({ title: "Tort type already exists", variant: "destructive" });
      return;
    }
    setData(prev => prev
      ? { ...prev, tort_types: [...prev.tort_types, t].sort() }
      : { tort_types: [t], configs: [] }
    );
    setNewTortType("");
    setAddingNew(false);
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-4 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }

  const tort_types = data?.tort_types ?? [];
  const configs = data?.configs ?? [];

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Portal Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure the client-facing portal for each tort campaign — branding, access control,
          and Fasten Health FHIR integration.
        </p>
      </div>

      <div className="space-y-3">
        {tort_types.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center">
              <Globe className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No tort types found.</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Add your first tort type below or create leads with a tort type.
              </p>
            </CardContent>
          </Card>
        )}

        {tort_types.map(t => (
          <TortCard
            key={t}
            tortType={t}
            config={configs.find(c => c.tort_type === t)}
            onSaved={handleSaved}
          />
        ))}
      </div>

      {/* Add a new tort type that has no leads yet */}
      <Card>
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add tort type
          </CardTitle>
          <CardDescription className="text-xs">
            Configure portal settings for a tort type before any leads exist.
          </CardDescription>
        </CardHeader>
        {addingNew ? (
          <CardContent className="pt-0 pb-4 flex gap-2">
            <Input
              value={newTortType}
              onChange={e => setNewTortType(e.target.value)}
              placeholder="e.g. camp-lejeune"
              className="h-8 text-sm flex-1"
              onKeyDown={e => { if (e.key === "Enter") handleAddNew(); }}
              autoFocus
            />
            <Button size="sm" onClick={handleAddNew} disabled={!newTortType.trim()}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAddingNew(false); setNewTortType(""); }}>Cancel</Button>
          </CardContent>
        ) : (
          <CardContent className="pt-0 pb-4">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAddingNew(true)}>
              <Plus className="h-3.5 w-3.5" /> Add tort type
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
