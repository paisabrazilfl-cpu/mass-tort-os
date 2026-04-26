import { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Plug, Plus, TestTube, RefreshCw, Trash2, Settings, CheckCircle, XCircle,
  Star, Search, Sparkles, Brain, FileSignature, Phone, MessageSquare, Mail,
  Printer, ScanText, MapPin, ShieldCheck, UserCheck, CreditCard, Database,
  Calendar as CalendarIcon, Briefcase, TrendingUp, Bot, Globe, Zap, Shield,
} from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface Preset {
  provider: string;
  name: string;
  type: string;
  category: string;
  description: string;
  docs_url: string;
  fields: string[];
  score: number;
  recommended?: boolean;
  pricing: "free" | "freemium" | "usage" | "subscription" | "enterprise";
  notes?: string;
}

interface Integration {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  api_url: string | null;
  api_key_hash: string | null;
  webhook_url: string | null;
  config: any;
  last_sync_at: string | null;
  sync_direction: string;
  created_at: string;
}

const categoryIcons: Record<string, typeof Plug> = {
  "AI / LLM": Brain,
  "E-Signature": FileSignature,
  "Voice AI Agent": Bot,
  "SMS & Telephony": Phone,
  "Email": Mail,
  "Fax": Printer,
  "OCR & Document AI": ScanText,
  "Address & Geo": MapPin,
  "Identity & KYC": UserCheck,
  "Background Check": ShieldCheck,
  "Phone Validation & Fraud": Phone,
  "TCPA Compliance": Shield,
  "File Storage": Database,
  "Payments": CreditCard,
  "Web Search": Search,
  "Calendar & Scheduling": CalendarIcon,
  "Legal CRM": Briefcase,
  "CRM": Briefcase,
  "Data Enrichment": TrendingUp,
  "Ad Platforms": TrendingUp,
  "Automation": Zap,
  "Lead Vendor & Routing": MessageSquare,
};

const pricingColors: Record<string, string> = {
  free: "bg-emerald-100 text-emerald-700 border-emerald-200",
  freemium: "bg-teal-100 text-teal-700 border-teal-200",
  usage: "bg-blue-100 text-blue-700 border-blue-200",
  subscription: "bg-purple-100 text-purple-700 border-purple-200",
  enterprise: "bg-amber-100 text-amber-700 border-amber-200",
};

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 9 ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : score >= 7 ? "bg-blue-100 text-blue-700 border-blue-200"
    : score >= 5 ? "bg-amber-100 text-amber-700 border-amber-200"
    : "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <Badge variant="outline" className={`text-xs font-mono ${tone}`} data-testid={`score-${score}`}>
      {score}/10
    </Badge>
  );
}

export default function Integrations() {
  const { toast } = useToast();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [formData, setFormData] = useState({
    name: "", api_key: "", api_url: "", webhook_url: "",
    client_id: "", client_secret: "", account_sid: "",
    sync_direction: "bidirectional", type: "custom", provider: "custom",
  });
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [recommendedOnly, setRecommendedOnly] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [presetsRes, integrationsRes] = await Promise.all([
        apiFetchRaw("/api/integrations/presets"),
        apiFetchRaw("/api/integrations"),
      ]);
      setPresets(await presetsRes.json());
      setIntegrations(await integrationsRes.json());
    } catch {
      toast({ title: "Failed to load integrations", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const categories = useMemo(() => {
    const cats = Array.from(new Set(presets.map(p => p.category))).sort();
    return cats;
  }, [presets]);

  const filteredPresets = useMemo(() => {
    let list = [...presets];
    if (categoryFilter !== "all") list = list.filter(p => p.category === categoryFilter);
    if (recommendedOnly) list = list.filter(p => p.recommended);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return b.score - a.score;
    });
    return list;
  }, [presets, search, categoryFilter, recommendedOnly]);

  const groupedByCategory = useMemo(() => {
    const map = new Map<string, Preset[]>();
    filteredPresets.forEach(p => {
      const arr = map.get(p.category) || [];
      arr.push(p);
      map.set(p.category, arr);
    });
    return Array.from(map.entries());
  }, [filteredPresets]);

  const connectPreset = (p: Preset) => {
    setSelectedPreset(p);
    setFormData({
      name: p.name, api_key: "", api_url: "", webhook_url: "",
      client_id: "", client_secret: "", account_sid: "",
      sync_direction: "bidirectional", type: p.type, provider: p.provider,
    });
    setAddOpen(true);
  };

  const openCustom = (kind: "custom" | "vendor" | "webpage") => {
    setFormData({
      name: "", api_key: "", api_url: "", webhook_url: "",
      client_id: "", client_secret: "", account_sid: "",
      sync_direction: "bidirectional", type: kind, provider: kind,
    });
    setCustomOpen(true);
  };

  const saveIntegration = async (isCustom: boolean) => {
    const body = isCustom
      ? formData
      : { ...formData, type: selectedPreset?.type, provider: selectedPreset?.provider };
    const res = await apiFetchRaw("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      toast({ title: "Connected", description: `${body.name} is now active` });
      setAddOpen(false);
      setCustomOpen(false);
      fetchData();
    } else {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const testIntegration = async (id: number) => {
    setTesting(id);
    const res = await apiFetchRaw(`/api/integrations/${id}/test`, { method: "POST" });
    const data = await res.json();
    toast({
      title: data.success ? "Connection verified" : "Connection failed",
      description: data.message || `Latency: ${data.latency_ms}ms`,
      variant: data.success ? "default" : "destructive",
    });
    setTesting(null);
    fetchData();
  };

  const syncIntegration = async (id: number) => {
    setSyncing(id);
    const res = await apiFetchRaw(`/api/integrations/${id}/sync`, { method: "POST" });
    const data = await res.json();
    toast({ title: "Sync complete", description: `${data.records_synced} records (${data.direction})` });
    setSyncing(null);
    fetchData();
  };

  const deleteIntegration = async (id: number) => {
    if (!confirm("Disconnect this integration?")) return;
    await apiFetchRaw(`/api/integrations/${id}`, { method: "DELETE" });
    toast({ title: "Disconnected" });
    fetchData();
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Plug className="h-7 w-7" />
            Integrations Hub
          </h1>
          <p className="text-muted-foreground mt-1">
            Bring your own API keys for AI engines, e-signature, voice agents, telephony, and more.
            Pick a provider, paste your key, and MTOS handles the rest.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => openCustom("vendor")} data-testid="button-add-vendor">
            <Plus className="h-4 w-4 mr-1" /> Vendor API
          </Button>
          <Button variant="outline" onClick={() => openCustom("webpage")} data-testid="button-add-webpage">
            <Plus className="h-4 w-4 mr-1" /> Web Page / URL
          </Button>
          <Button variant="outline" onClick={() => openCustom("custom")} data-testid="button-add-custom">
            <Plus className="h-4 w-4 mr-1" /> Custom REST
          </Button>
        </div>
      </div>

      {/* Active connections */}
      {integrations.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <h2 className="text-xl font-semibold">Active Connections ({integrations.length})</h2>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Sync</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {integrations.map((i) => (
                  <TableRow key={i.id} data-testid={`row-integration-${i.id}`}>
                    <TableCell className="font-medium">{i.name}</TableCell>
                    <TableCell><Badge variant="outline">{i.provider}</Badge></TableCell>
                    <TableCell><Badge variant="outline">{i.type}</Badge></TableCell>
                    <TableCell>
                      {i.status === "active" ? (
                        <Badge className="bg-green-100 text-green-700"><CheckCircle className="h-3 w-3 mr-1" />Active</Badge>
                      ) : (
                        <Badge className="bg-gray-100 text-gray-700"><XCircle className="h-3 w-3 mr-1" />Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {i.last_sync_at ? new Date(i.last_sync_at).toLocaleString() : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => testIntegration(i.id)} disabled={testing === i.id} data-testid={`button-test-${i.id}`}>
                          <TestTube className={`h-4 w-4 ${testing === i.id ? "animate-pulse" : ""}`} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => syncIntegration(i.id)} disabled={syncing === i.id} data-testid={`button-sync-${i.id}`}>
                          <RefreshCw className={`h-4 w-4 ${syncing === i.id ? "animate-spin" : ""}`} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteIntegration(i.id)} data-testid={`button-delete-${i.id}`}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[240px]">
              <Label className="text-xs">Search providers</Label>
              <div className="relative mt-1">
                <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="DocuSign, Claude, Twilio…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="input-search"
                />
              </div>
            </div>
            <div className="min-w-[220px]">
              <Label className="text-xs">Category</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="mt-1" data-testid="select-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories ({presets.length})</SelectItem>
                  {categories.map(c => {
                    const count = presets.filter(p => p.category === c).length;
                    return <SelectItem key={c} value={c}>{c} ({count})</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant={recommendedOnly ? "default" : "outline"}
              onClick={() => setRecommendedOnly(v => !v)}
              data-testid="button-recommended-toggle"
            >
              <Star className={`h-4 w-4 mr-1 ${recommendedOnly ? "fill-current" : ""}`} />
              Recommended only
            </Button>
          </div>
          <div className="text-xs text-muted-foreground mt-3">
            Showing {filteredPresets.length} of {presets.length} providers. Sorted by recommendation, then score.
          </div>
        </CardContent>
      </Card>

      {/* Provider grid grouped by category */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading providers…</div>
      ) : (
        <div className="space-y-8">
          {groupedByCategory.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">No providers match your filters.</div>
          )}
          {groupedByCategory.map(([category, items]) => {
            const Icon = categoryIcons[category] || Plug;
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold">{category}</h2>
                  <Badge variant="outline" className="ml-1">{items.length}</Badge>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {items.map((p) => {
                    const isConnected = integrations.some(i => i.provider === p.provider);
                    return (
                      <Card
                        key={p.provider}
                        className={`relative ${isConnected ? "border-green-300 bg-green-50/40" : ""} ${p.recommended ? "ring-1 ring-amber-200" : ""}`}
                        data-testid={`card-preset-${p.provider}`}
                      >
                        {p.recommended && (
                          <div className="absolute -top-2 -right-2">
                            <Badge className="bg-amber-500 text-white border-amber-600 shadow-sm">
                              <Sparkles className="h-3 w-3 mr-1" /> Recommended
                            </Badge>
                          </div>
                        )}
                        <CardContent className="pt-6">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold truncate">{p.name}</div>
                              <div className="flex flex-wrap gap-1 mt-1">
                                <ScoreBadge score={p.score} />
                                <Badge variant="outline" className={`text-xs capitalize ${pricingColors[p.pricing]}`}>
                                  {p.pricing}
                                </Badge>
                                {isConnected && (
                                  <Badge className="bg-green-100 text-green-700 text-xs">Connected</Badge>
                                )}
                              </div>
                            </div>
                          </div>
                          <p className="text-sm text-muted-foreground mt-3 line-clamp-3">{p.description}</p>
                          {p.notes && (
                            <p className="text-xs italic text-muted-foreground/80 mt-2 border-l-2 border-amber-200 pl-2">
                              {p.notes}
                            </p>
                          )}
                          <div className="flex gap-2 mt-4">
                            <Button
                              size="sm"
                              variant={isConnected ? "outline" : "default"}
                              className="flex-1"
                              onClick={() => connectPreset(p)}
                              data-testid={`button-connect-${p.provider}`}
                            >
                              {isConnected ? "Reconfigure" : "Connect"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => window.open(p.docs_url, "_blank")}>
                              Docs
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Preset connect dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Connect {selectedPreset?.name}
              {selectedPreset && <ScoreBadge score={selectedPreset.score} />}
            </DialogTitle>
            <DialogDescription>{selectedPreset?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {selectedPreset?.notes && (
              <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
                <strong>Tip:</strong> {selectedPreset.notes}
              </div>
            )}
            <div className="grid gap-2">
              <Label>Display Name</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData(d => ({ ...d, name: e.target.value }))}
                data-testid="input-name"
              />
            </div>
            {selectedPreset?.fields.includes("api_key") && (
              <div className="grid gap-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  placeholder="Paste your API key…"
                  value={formData.api_key}
                  onChange={(e) => setFormData(d => ({ ...d, api_key: e.target.value }))}
                  data-testid="input-api-key"
                />
              </div>
            )}
            {selectedPreset?.fields.includes("account_sid") && (
              <div className="grid gap-2">
                <Label>Account SID / Account ID</Label>
                <Input
                  placeholder="ACxxxxxxxx…"
                  value={formData.account_sid}
                  onChange={(e) => setFormData(d => ({ ...d, account_sid: e.target.value }))}
                  data-testid="input-account-sid"
                />
              </div>
            )}
            {selectedPreset?.fields.includes("client_id") && (
              <div className="grid gap-2">
                <Label>Client ID</Label>
                <Input
                  placeholder="OAuth client ID"
                  value={formData.client_id}
                  onChange={(e) => setFormData(d => ({ ...d, client_id: e.target.value }))}
                  data-testid="input-client-id"
                />
              </div>
            )}
            {selectedPreset?.fields.includes("client_secret") && (
              <div className="grid gap-2">
                <Label>Client Secret</Label>
                <Input
                  type="password"
                  placeholder="OAuth client secret"
                  value={formData.client_secret}
                  onChange={(e) => setFormData(d => ({ ...d, client_secret: e.target.value }))}
                  data-testid="input-client-secret"
                />
              </div>
            )}
            {selectedPreset?.fields.includes("api_url") && (
              <div className="grid gap-2">
                <Label>API Base URL</Label>
                <Input
                  placeholder="https://api.example.com/v1"
                  value={formData.api_url}
                  onChange={(e) => setFormData(d => ({ ...d, api_url: e.target.value }))}
                  data-testid="input-api-url"
                />
              </div>
            )}
            {selectedPreset?.fields.includes("webhook_url") && (
              <div className="grid gap-2">
                <Label>Webhook URL</Label>
                <Input
                  placeholder="https://hooks.zapier.com/…"
                  value={formData.webhook_url}
                  onChange={(e) => setFormData(d => ({ ...d, webhook_url: e.target.value }))}
                  data-testid="input-webhook-url"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => saveIntegration(false)} data-testid="button-save-preset">Connect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom dialog */}
      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {formData.type === "vendor" ? "Connect Vendor API"
                : formData.type === "webpage" ? "Connect Web Page / Service"
                : "Custom API Integration"}
            </DialogTitle>
            <DialogDescription>
              {formData.type === "vendor" ? "Connect to a vendor's API for lead exchange and reporting."
                : formData.type === "webpage" ? "Add a web page or external service connection."
                : "Configure a custom REST API connection."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                placeholder={formData.type === "vendor" ? "Vendor Name" : "Integration Name"}
                value={formData.name}
                onChange={(e) => setFormData(d => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Provider / Identifier</Label>
              <Input
                placeholder="e.g. my-custom-crm"
                value={formData.provider}
                onChange={(e) => setFormData(d => ({ ...d, provider: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>{formData.type === "webpage" ? "URL" : "API Base URL"}</Label>
              <Input
                placeholder="https://api.example.com/v1"
                value={formData.api_url}
                onChange={(e) => setFormData(d => ({ ...d, api_url: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>API Key (optional)</Label>
              <Input
                type="password"
                placeholder="Enter API key…"
                value={formData.api_key}
                onChange={(e) => setFormData(d => ({ ...d, api_key: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Webhook URL (optional)</Label>
              <Input
                placeholder="https://hooks.example.com/…"
                value={formData.webhook_url}
                onChange={(e) => setFormData(d => ({ ...d, webhook_url: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Sync Direction</Label>
              <Select value={formData.sync_direction} onValueChange={(v) => setFormData(d => ({ ...d, sync_direction: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bidirectional">Bidirectional</SelectItem>
                  <SelectItem value="push">Push (MTOS to External)</SelectItem>
                  <SelectItem value="pull">Pull (External to MTOS)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomOpen(false)}>Cancel</Button>
            <Button onClick={() => saveIntegration(true)}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
