import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plug, Plus, TestTube, RefreshCw, Trash2, Settings, CheckCircle, XCircle, Globe, Zap, Briefcase, Shield } from "lucide-react";

interface Preset {
  provider: string;
  name: string;
  type: string;
  description: string;
  category: string;
  docs_url: string;
  fields: string[];
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

const typeIcons: Record<string, typeof Plug> = {
  crm: Briefcase,
  automation: Zap,
  service: Shield,
  custom: Globe,
  vendor: Globe,
  webpage: Globe,
};

const categoryColors: Record<string, string> = {
  "CRM": "bg-blue-100 text-blue-700",
  "Legal CRM": "bg-indigo-100 text-indigo-700",
  "Automation": "bg-purple-100 text-purple-700",
  "Compliance Service": "bg-red-100 text-red-700",
  "Legal Service": "bg-teal-100 text-teal-700",
  "Custom": "bg-gray-100 text-gray-700",
  "Vendor": "bg-orange-100 text-orange-700",
  "Web Page": "bg-green-100 text-green-700",
};

export default function Integrations() {
  const { toast } = useToast();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [formData, setFormData] = useState({ name: "", api_key: "", api_url: "", webhook_url: "", sync_direction: "bidirectional", type: "custom", provider: "custom" });
  const [testing, setTesting] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("all");

  const fetchData = async () => {
    setLoading(true);
    try {
      const [presetsRes, integrationsRes] = await Promise.all([
        fetch("/api/integrations/presets"),
        fetch("/api/integrations"),
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

  const connectPreset = (preset: Preset) => {
    setSelectedPreset(preset);
    setFormData({ name: preset.name, api_key: "", api_url: "", webhook_url: "", sync_direction: "bidirectional", type: preset.type, provider: preset.provider });
    setAddOpen(true);
  };

  const openCustom = (type: string) => {
    setSelectedPreset(null);
    setFormData({ name: "", api_key: "", api_url: "", webhook_url: "", sync_direction: "bidirectional", type, provider: "custom" });
    setCustomOpen(true);
  };

  const saveIntegration = async (isCustom: boolean) => {
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) throw new Error("Failed");
      toast({ title: `${formData.name} connected successfully` });
      setAddOpen(false);
      setCustomOpen(false);
      fetchData();
    } catch {
      toast({ title: "Failed to save integration", variant: "destructive" });
    }
  };

  const testConnection = async (id: number) => {
    setTesting(id);
    try {
      const res = await fetch(`/api/integrations/${id}/test`, { method: "POST" });
      const result = await res.json();
      toast({ title: result.success ? `Connection verified (${result.latency_ms}ms)` : "Connection failed" });
    } catch {
      toast({ title: "Test failed", variant: "destructive" });
    } finally {
      setTesting(null);
    }
  };

  const syncIntegration = async (id: number) => {
    setSyncing(id);
    try {
      const res = await fetch(`/api/integrations/${id}/sync`, { method: "POST" });
      const result = await res.json();
      toast({ title: `Synced ${result.records_synced} records` });
      fetchData();
    } catch {
      toast({ title: "Sync failed", variant: "destructive" });
    } finally {
      setSyncing(null);
    }
  };

  const toggleStatus = async (id: number, currentStatus: string) => {
    try {
      await fetch(`/api/integrations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: currentStatus === "active" ? "inactive" : "active" }),
      });
      fetchData();
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  const deleteIntegration = async (id: number) => {
    try {
      await fetch(`/api/integrations/${id}`, { method: "DELETE" });
      toast({ title: "Integration removed" });
      fetchData();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };

  const filteredPresets = activeTab === "all" ? presets : presets.filter(p => {
    if (activeTab === "crm") return p.type === "crm";
    if (activeTab === "services") return p.type === "service";
    return false;
  });

  const crmPresets = presets.filter(p => p.type === "crm");
  const servicePresets = presets.filter(p => p.type === "service");
  const automationPresets = presets.filter(p => p.type === "automation");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Integrations Hub</h1>
          <p className="text-muted-foreground">Connect MTOS to CRMs, vendors, compliance services, and custom APIs.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => openCustom("custom")}><Plus className="h-4 w-4 mr-2" />Custom API</Button>
          <Button variant="outline" onClick={() => openCustom("vendor")}><Plus className="h-4 w-4 mr-2" />Vendor API</Button>
          <Button variant="outline" onClick={() => openCustom("webpage")}><Plus className="h-4 w-4 mr-2" />Web Page</Button>
        </div>
      </div>

      {integrations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active Connections ({integrations.length})</CardTitle>
            <CardDescription>Manage your connected integrations</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Integration</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Sync</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {integrations.map((i) => {
                  const Icon = typeIcons[i.type] || Plug;
                  return (
                    <TableRow key={i.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4" />
                          <span className="font-medium">{i.name}</span>
                          <span className="text-xs text-muted-foreground">({i.provider})</span>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className={categoryColors[i.type] || ""}>{i.type}</Badge></TableCell>
                      <TableCell>
                        <Badge className={i.status === "active" ? "bg-green-100 text-green-700 cursor-pointer" : "bg-gray-100 text-gray-600 cursor-pointer"} onClick={() => toggleStatus(i.id, i.status)}>
                          {i.status === "active" ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                          {i.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{i.last_sync_at ? new Date(i.last_sync_at).toLocaleDateString() : "Never"}</TableCell>
                      <TableCell className="text-sm">{i.sync_direction}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => testConnection(i.id)} disabled={testing === i.id}>
                            <TestTube className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => syncIntegration(i.id)} disabled={syncing === i.id}>
                            <RefreshCw className={`h-4 w-4 ${syncing === i.id ? "animate-spin" : ""}`} />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => deleteIntegration(i.id)}>
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">All Connectors</TabsTrigger>
          <TabsTrigger value="crm">CRMs ({crmPresets.length})</TabsTrigger>
          <TabsTrigger value="services">Services ({servicePresets.length})</TabsTrigger>
          <TabsTrigger value="automation">Automation ({automationPresets.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {presets.map((p) => {
              const Icon = typeIcons[p.type] || Plug;
              const isConnected = integrations.some(i => i.provider === p.provider);
              return (
                <Card key={p.provider} className={isConnected ? "border-green-300 bg-green-50/50" : ""}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <div className="font-medium">{p.name}</div>
                          <Badge variant="outline" className={`text-xs ${categoryColors[p.category] || ""}`}>{p.category}</Badge>
                        </div>
                      </div>
                      {isConnected && <Badge className="bg-green-100 text-green-700">Connected</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground mt-3">{p.description}</p>
                    <div className="flex gap-2 mt-4">
                      <Button size="sm" variant={isConnected ? "outline" : "default"} className="flex-1" onClick={() => connectPreset(p)}>
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
        </TabsContent>

        <TabsContent value="crm" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {crmPresets.map((p) => {
              const isConnected = integrations.some(i => i.provider === p.provider);
              return (
                <Card key={p.provider} className={isConnected ? "border-green-300 bg-green-50/50" : ""}>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3 mb-3">
                      <Briefcase className="h-5 w-5 text-primary" />
                      <div className="font-medium">{p.name}</div>
                      {isConnected && <Badge className="bg-green-100 text-green-700 ml-auto">Connected</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                    <Button size="sm" className="w-full mt-4" variant={isConnected ? "outline" : "default"} onClick={() => connectPreset(p)}>
                      {isConnected ? "Reconfigure" : "Connect"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="services" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {servicePresets.map((p) => {
              const isConnected = integrations.some(i => i.provider === p.provider);
              return (
                <Card key={p.provider} className={isConnected ? "border-green-300 bg-green-50/50" : ""}>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3 mb-3">
                      <Shield className="h-5 w-5 text-red-600" />
                      <div className="font-medium">{p.name}</div>
                      {isConnected && <Badge className="bg-green-100 text-green-700 ml-auto">Connected</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                    <Button size="sm" className="w-full mt-4" variant={isConnected ? "outline" : "default"} onClick={() => connectPreset(p)}>
                      {isConnected ? "Reconfigure" : "Connect"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="automation" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {automationPresets.map((p) => {
              const isConnected = integrations.some(i => i.provider === p.provider);
              return (
                <Card key={p.provider} className={isConnected ? "border-green-300 bg-green-50/50" : ""}>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3 mb-3">
                      <Zap className="h-5 w-5 text-purple-600" />
                      <div className="font-medium">{p.name}</div>
                      {isConnected && <Badge className="bg-green-100 text-green-700 ml-auto">Connected</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                    <Button size="sm" className="w-full mt-4" variant={isConnected ? "outline" : "default"} onClick={() => connectPreset(p)}>
                      {isConnected ? "Reconfigure" : "Connect"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect {selectedPreset?.name}</DialogTitle>
            <DialogDescription>{selectedPreset?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-2">
              <Label>Display Name</Label>
              <Input value={formData.name} onChange={(e) => setFormData(d => ({ ...d, name: e.target.value }))} />
            </div>
            {selectedPreset?.fields.includes("api_key") && (
              <div className="grid gap-2">
                <Label>API Key</Label>
                <Input type="password" placeholder="Enter API key..." value={formData.api_key} onChange={(e) => setFormData(d => ({ ...d, api_key: e.target.value }))} />
              </div>
            )}
            {selectedPreset?.fields.includes("api_url") && (
              <div className="grid gap-2">
                <Label>API Base URL</Label>
                <Input placeholder="https://api.example.com/v1" value={formData.api_url} onChange={(e) => setFormData(d => ({ ...d, api_url: e.target.value }))} />
              </div>
            )}
            {selectedPreset?.fields.includes("webhook_url") && (
              <div className="grid gap-2">
                <Label>Webhook URL</Label>
                <Input placeholder="https://hooks.zapier.com/..." value={formData.webhook_url} onChange={(e) => setFormData(d => ({ ...d, webhook_url: e.target.value }))} />
              </div>
            )}
            <div className="grid gap-2">
              <Label>Sync Direction</Label>
              <Select value={formData.sync_direction} onValueChange={(v) => setFormData(d => ({ ...d, sync_direction: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bidirectional">Bidirectional</SelectItem>
                  <SelectItem value="push">Push (MTOS to CRM)</SelectItem>
                  <SelectItem value="pull">Pull (CRM to MTOS)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => saveIntegration(false)}>Connect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {formData.type === "vendor" ? "Connect Vendor API" : formData.type === "webpage" ? "Connect Web Page / Service" : "Custom API Integration"}
            </DialogTitle>
            <DialogDescription>
              {formData.type === "vendor" ? "Connect to a vendor's API for lead exchange and reporting." : formData.type === "webpage" ? "Add a web page or external service connection." : "Configure a custom REST API connection."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input placeholder={formData.type === "vendor" ? "Vendor Name" : "Integration Name"} value={formData.name} onChange={(e) => setFormData(d => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label>Provider / Identifier</Label>
              <Input placeholder="e.g. my-custom-crm" value={formData.provider} onChange={(e) => setFormData(d => ({ ...d, provider: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label>{formData.type === "webpage" ? "URL" : "API Base URL"}</Label>
              <Input placeholder="https://api.example.com/v1" value={formData.api_url} onChange={(e) => setFormData(d => ({ ...d, api_url: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label>API Key (optional)</Label>
              <Input type="password" placeholder="Enter API key..." value={formData.api_key} onChange={(e) => setFormData(d => ({ ...d, api_key: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label>Webhook URL (optional)</Label>
              <Input placeholder="https://hooks.example.com/..." value={formData.webhook_url} onChange={(e) => setFormData(d => ({ ...d, webhook_url: e.target.value }))} />
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
