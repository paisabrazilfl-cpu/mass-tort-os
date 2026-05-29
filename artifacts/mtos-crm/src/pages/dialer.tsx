import React, { useState, useRef, useEffect, useCallback } from "react";
import Vapi from "@vapi-ai/web";
import { getAccessToken } from "@/lib/auth-store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Phone, PhoneCall, PhoneOff, PhoneMissed, Play, Pause, StopCircle,
  BarChart3, Users, FileText, ShieldOff, Mic, MicOff, Volume2,
  Plus, Trash2, Edit, Download, Upload, RefreshCw, CheckCircle,
  XCircle, Clock, TrendingUp, AlertTriangle, Headphones, Loader2,
  Delete, Hash, Star, Bot, Link2, Settings, Zap,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";

const API = (path: string) => `/api/dialer${path}`;

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(API(path), {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? "Request failed");
  }
  return res.json() as Promise<T>;
}

// ─── STATS CARDS ─────────────────────────────────────────────────────────────

function StatsTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["dialer-stats"],
    queryFn: () => apiFetch<any>("/stats"),
    refetchInterval: 15000,
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  const t = data?.today ?? {};
  const c = data?.campaigns ?? {};

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Calls Today", value: t.total_calls ?? 0, icon: Phone, color: "text-blue-600" },
          { label: "Connected", value: t.connected ?? 0, icon: CheckCircle, color: "text-green-600" },
          { label: "In Progress", value: t.in_progress ?? 0, icon: PhoneCall, color: "text-yellow-600" },
          { label: "Connect Rate", value: `${t.connect_rate ?? 0}%`, icon: TrendingUp, color: "text-purple-600" },
          { label: "Active Campaigns", value: c.active ?? 0, icon: Play, color: "text-green-600" },
          { label: "Paused", value: c.paused ?? 0, icon: Pause, color: "text-orange-500" },
          { label: "Total Campaigns", value: c.total ?? 0, icon: BarChart3, color: "text-blue-600" },
          { label: "DNC Entries", value: data?.dnc_count ?? 0, icon: ShieldOff, color: "text-red-500" },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">{s.label}</span>
                <s.icon className={`h-4 w-4 ${s.color}`} />
              </div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Live Status</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Auto-refreshes every 15s
            </span>
          </div>
        </CardContent>
      </Card>

      <VapiSetupCard />
    </div>
  );
}

// ─── VAPI SETUP WIZARD ────────────────────────────────────────────────────────

function VapiSetupCard() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["dialer-vapi-config"],
    queryFn: () => apiFetch<any>("/vapi-config"),
    retry: false,
  });

  const hasApiKey = !!data?.public_key || data?.assistants !== undefined;
  const hasPublicKey = !!data?.public_key;
  const hasAssistant = Array.isArray(data?.assistants) && data.assistants.length > 0;
  const allDone = hasApiKey && hasPublicKey && hasAssistant;

  const createMut = useMutation({
    mutationFn: () => apiFetch<any>("/vapi-assistant", {
      method: "POST",
      body: JSON.stringify({ name: "MTOS Campaign Assistant", first_message: "Hello, I'm calling from a law firm regarding a potential legal claim. Is now a good time to speak?" }),
    }),
    onSuccess: () => { refetch(); },
  });

  if (isLoading) return null;

  const step = (done: boolean, label: string, sub: string, action?: React.ReactNode) => (
    <div className="flex items-start gap-3">
      <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${done ? "bg-green-500" : "bg-gray-200"}`}>
        {done ? <CheckCircle className="h-3 w-3 text-white" /> : <span className="text-xs text-gray-500 font-bold">!</span>}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${done ? "text-gray-700 line-through decoration-gray-400" : "text-gray-900"}`}>{label}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
        {!done && action && <div className="mt-1.5">{action}</div>}
      </div>
    </div>
  );

  if (allDone) {
    return (
      <Card className="border-green-200 bg-green-50">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 text-green-700">
            <Zap className="h-4 w-4" />
            <span className="text-sm font-semibold">Vapi is fully configured</span>
            <span className="text-xs text-green-600 ml-1">— {data.assistants.length} assistant{data.assistants.length !== 1 ? "s" : ""} ready</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-blue-600" />
          <CardTitle className="text-sm font-semibold text-blue-800">Vapi Setup</CardTitle>
          <span className="text-xs text-muted-foreground ml-auto">Complete all steps to enable auto-dialing</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        {step(
          hasApiKey,
          "Add Vapi API key",
          "Go to Integrations → Voice AI → Vapi and paste your private API key.",
          <a href="/integrations" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium">
            <Settings className="h-3 w-3" /> Open Integrations
          </a>,
        )}
        {step(
          hasPublicKey,
          "Add Vapi public key (Web SDK)",
          "Also add the public key from Vapi dashboard → API Keys → 'Web' — required for browser calls.",
          <a href="/integrations" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium">
            <Link2 className="h-3 w-3" /> Open Integrations
          </a>,
        )}
        {step(
          hasAssistant,
          "Create a Vapi assistant",
          "An AI assistant handles the conversation on each call. Click to auto-create one with the MTOS defaults.",
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!hasApiKey || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Bot className="h-3 w-3 mr-1" />}
            Auto-create assistant
          </Button>,
        )}
      </CardContent>
    </Card>
  );
}

// ─── CAMPAIGN PROGRESS BAR ────────────────────────────────────────────────────

function CampaignProgressBar({ campaignId, totalLeads }: { campaignId: number; totalLeads: number }) {
  const { data } = useQuery({
    queryKey: ["campaign-progress", campaignId],
    queryFn: () => apiFetch<any>(`/campaigns/${campaignId}/progress`),
    refetchInterval: 4000,
  });

  const pct = data?.progress_pct ?? 0;
  const leads = data?.leads ?? {};
  const dialed = (leads.called ?? 0) + (leads.connected ?? 0) + (leads.failed ?? 0) + (leads.voicemail ?? 0) + (leads.dnc ?? 0);
  const dialing = leads.dialing ?? 0;

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <Progress value={pct} className="h-1.5" />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
        <span>{dialed}/{totalLeads} dialed</span>
        {dialing > 0 && (
          <span className="inline-flex items-center gap-1 text-green-600 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            {dialing} live
          </span>
        )}
        <span className="text-green-700 font-medium">{pct}%</span>
        {leads.connected > 0 && <span className="text-blue-600">{leads.connected} connected</span>}
        {leads.dnc > 0 && <span className="text-red-500">{leads.dnc} DNC</span>}
      </div>
    </div>
  );
}

// ─── CAMPAIGNS ────────────────────────────────────────────────────────────────

const CAMPAIGN_TYPES = ["predictive", "preview", "power", "manual"] as const;
const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;

function statusBadge(status: string) {
  const map: Record<string, string> = {
    active: "bg-green-100 text-green-800",
    paused: "bg-yellow-100 text-yellow-800",
    draft: "bg-gray-100 text-gray-700",
    completed: "bg-blue-100 text-blue-800",
    archived: "bg-red-100 text-red-700",
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? "bg-gray-100"}`}>{status}</span>;
}

function CampaignsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "", type: "preview", caller_id: "", retry_attempts: 3,
    max_concurrent_calls: 1, call_window_start: "09:00", call_window_end: "20:00",
    timezone: "America/New_York", notes: "",
    tort: "", vapi_assistant_id: "", vapi_phone_number_id: "",
  });

  const { data, isLoading, refetch: refetchCampaigns } = useQuery({
    queryKey: ["dialer-campaigns"],
    queryFn: () => apiFetch<any>("/campaigns"),
    refetchInterval: (query) => {
      const campaigns: any[] = query.state.data?.campaigns ?? [];
      return campaigns.some((c: any) => c.status === "active") ? 5000 : false;
    },
  });

  const { data: vapiCfg } = useQuery({
    queryKey: ["dialer-vapi-config"],
    queryFn: () => apiFetch<any>("/vapi-config"),
    retry: false,
  });

  const { data: vapiPhones } = useQuery({
    queryKey: ["dialer-vapi-phones"],
    queryFn: () => apiFetch<any>("/vapi-phones"),
    retry: false,
  });

  const { data: tortAgentsData } = useQuery({
    queryKey: ["dialer-tort-agents"],
    queryFn: () => apiFetch<any>("/tort-agents"),
    retry: false,
  });

  const assistants: any[] = vapiCfg?.assistants ?? [];
  const phoneNumbers: any[] = vapiPhones?.phone_numbers ?? [];
  const tortAgents: any[] = tortAgentsData?.agents ?? [];

  // Task #90: selecting a tort auto-links the campaign to that tort's
  // dedicated voice agent when one is provisioned and active.
  const onTortChange = (tortId: string) => {
    const agent = tortAgents.find((a) => a.tort_id === tortId);
    setForm((f) => ({
      ...f,
      tort: tortId,
      vapi_assistant_id:
        agent?.vapi_assistant_id && agent.status === "active"
          ? agent.vapi_assistant_id
          : f.vapi_assistant_id,
    }));
  };

  const createMut = useMutation({
    mutationFn: (body: typeof form) => apiFetch("/campaigns", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dialer-campaigns"] }); setShowCreate(false); toast({ title: "Campaign created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const startMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/campaigns/${id}/start`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dialer-campaigns"] }),
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const pauseMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/campaigns/${id}/pause`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dialer-campaigns"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dialer-campaigns"] }); toast({ title: "Campaign deleted" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const campaigns: any[] = data?.campaigns ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New Campaign
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : campaigns.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground text-sm">No campaigns yet. Create one to start dialing.</CardContent></Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Dialed</TableHead>
                <TableHead className="text-right">Connected</TableHead>
                <TableHead className="text-right">Conv.</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c: any) => (
                <>
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {c.status === "active" && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />}
                        {c.name}
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{c.type}</Badge></TableCell>
                    <TableCell>{statusBadge(c.status)}</TableCell>
                    <TableCell className="text-right">{c.total_leads}</TableCell>
                    <TableCell className="text-right">{c.dialed_count}</TableCell>
                    <TableCell className="text-right">{c.connected_count}</TableCell>
                    <TableCell className="text-right">{c.converted_count}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {c.status !== "active" && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-600" title="Start campaign" onClick={() => startMut.mutate(c.id)}>
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {c.status === "active" && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-yellow-600" title="Pause campaign" onClick={() => pauseMut.mutate(c.id)}>
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" title="Delete campaign" onClick={() => { if (confirm("Delete campaign?")) deleteMut.mutate(c.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {c.status === "active" && (
                    <TableRow key={`${c.id}-progress`} className="bg-green-50/50 hover:bg-green-50/50">
                      <TableCell colSpan={8} className="py-1.5 px-4">
                        <CampaignProgressBar campaignId={c.id} totalLeads={c.total_leads} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Dialing Campaign</DialogTitle>
            <DialogDescription>Configure an outbound dialing campaign.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Campaign Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Q3 Mass Tort Outreach" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Dialer Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAMPAIGN_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Caller ID</Label>
                <Input value={form.caller_id} onChange={(e) => setForm((f) => ({ ...f, caller_id: e.target.value }))} placeholder="+15551234567" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Concurrent Calls</Label>
                <Input type="number" min={1} max={50} value={form.max_concurrent_calls} onChange={(e) => setForm((f) => ({ ...f, max_concurrent_calls: parseInt(e.target.value) || 1 }))} />
              </div>
              <div>
                <Label>Retry Attempts</Label>
                <Input type="number" min={0} max={10} value={form.retry_attempts} onChange={(e) => setForm((f) => ({ ...f, retry_attempts: parseInt(e.target.value) || 0 }))} />
              </div>
              <div>
                <Label>Timezone</Label>
                <Select value={form.timezone} onValueChange={(v) => setForm((f) => ({ ...f, timezone: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix"].map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz.replace("America/", "")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Call Window Start</Label>
                <Input type="time" value={form.call_window_start} onChange={(e) => setForm((f) => ({ ...f, call_window_start: e.target.value }))} />
              </div>
              <div>
                <Label>Call Window End</Label>
                <Input type="time" value={form.call_window_end} onChange={(e) => setForm((f) => ({ ...f, call_window_end: e.target.value }))} />
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Vapi Auto-Dialing</p>
              {tortAgents.length > 0 && (
                <div className="mb-3">
                  <Label>Tort (auto-links voice agent)</Label>
                  <Select value={form.tort} onValueChange={onTortChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a tort to auto-assign its agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {tortAgents.map((t: any) => (
                        <SelectItem key={t.tort_id} value={t.tort_id}>
                          {t.tort_label}
                          {t.status === "active" ? "" : " — no agent yet"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">Picks the tort's dedicated agent when provisioned</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Vapi Assistant</Label>
                  <Select value={form.vapi_assistant_id} onValueChange={(v) => setForm((f) => ({ ...f, vapi_assistant_id: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder={assistants.length === 0 ? "No assistants yet" : "Select assistant"} />
                    </SelectTrigger>
                    <SelectContent>
                      {assistants.map((a: any) => (
                        <SelectItem key={a.id} value={a.id}>{a.name ?? a.id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">Required for predictive/power/preview auto-dial</p>
                </div>
                <div>
                  <Label>Vapi Phone Number</Label>
                  <Select value={form.vapi_phone_number_id} onValueChange={(v) => setForm((f) => ({ ...f, vapi_phone_number_id: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder={phoneNumbers.length === 0 ? "None (use caller ID)" : "Select number"} />
                    </SelectTrigger>
                    <SelectContent>
                      {phoneNumbers.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>{p.number ?? p.id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-0.5">Optional — defaults to Caller ID above</p>
                </div>
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button disabled={!form.name || createMut.isPending} onClick={() => createMut.mutate(form)}>
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Create Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── MANUAL DIAL ─────────────────────────────────────────────────────────────

type CallState = "idle" | "connecting" | "active" | "ended";

interface VapiConfig {
  configured: boolean;
  public_key: string | null;
  assistants: { id: string; name?: string }[];
}

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

function ManualDialTab() {
  const { toast } = useToast();
  const [number, setNumber] = useState("");
  const [callState, setCallState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [callDuration, setCallDuration] = useState(0);
  const [selectedAssistant, setSelectedAssistant] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [setupName, setSetupName] = useState("MTOS Intake Agent");
  const [setupVoice, setSetupVoice] = useState("alloy");

  const vapiRef = useRef<Vapi | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const { data: vapiConfig, refetch: refetchConfig } = useQuery<VapiConfig>({
    queryKey: ["dialer-vapi-config"],
    queryFn: () => apiFetch<VapiConfig>("/vapi-config"),
    staleTime: 30_000,
  });

  // Per-tort dedicated agents. Picking a tort selects its provisioned agent
  // so staff dial a lead with that tort's voice agent.
  const { data: tortAgentsData } = useQuery<{ agents: any[] }>({
    queryKey: ["dialer-tort-agents"],
    queryFn: () => apiFetch<{ agents: any[] }>("/tort-agents"),
    staleTime: 30_000,
  });
  const activeTortAgents: any[] = (tortAgentsData?.agents ?? []).filter(
    (a) => a.vapi_assistant_id && a.status === "active",
  );

  const selectTortAgent = useCallback(
    (tortId: string) => {
      const agent = activeTortAgents.find((a) => a.tort_id === tortId);
      if (agent?.vapi_assistant_id) setSelectedAssistant(agent.vapi_assistant_id);
    },
    [activeTortAgents],
  );

  const setupMut = useMutation({
    mutationFn: () =>
      apiFetch<any>("/vapi-assistant", {
        method: "POST",
        body: JSON.stringify({ name: setupName, voice_id: setupVoice }),
      }),
    onSuccess: (r) => {
      toast({ title: "Assistant created", description: `${r.name} (${r.model})` });
      setShowSetup(false);
      refetchConfig();
      setSelectedAssistant(r.assistant_id);
    },
    onError: (e: Error) => toast({ title: "Setup failed", description: e.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (vapiConfig?.assistants?.length && !selectedAssistant) {
      setSelectedAssistant(vapiConfig.assistants[0].id);
    }
  }, [vapiConfig, selectedAssistant]);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  useEffect(() => {
    return () => {
      vapiRef.current?.stop();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const appendDigit = (d: string) => setNumber((n) => n + d);
  const backspace = () => setNumber((n) => n.slice(0, -1));
  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const startCall = useCallback(() => {
    if (!vapiConfig?.public_key) {
      toast({
        title: "Public key missing",
        description: "Add your Vapi public key in Integrations → Voice AI (Vapi) → public_key field.",
        variant: "destructive",
      });
      return;
    }
    if (!selectedAssistant) {
      toast({
        title: "No assistant selected",
        description: "Click Setup Assistant to create one powered by Qwen3-235B.",
        variant: "destructive",
      });
      return;
    }

    setCallState("connecting");
    setTranscript([]);
    setCallDuration(0);
    setMuted(false);
    setVolume(0);

    const vapi = new Vapi(vapiConfig.public_key);
    vapiRef.current = vapi;

    vapi.on("call-start", () => {
      setCallState("active");
      timerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000);
    });

    vapi.on("call-end", () => {
      setCallState("ended");
      setVolume(0);
      setAgentSpeaking(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setTimeout(() => setCallState("idle"), 3000);
    });

    vapi.on("speech-start", () => setAgentSpeaking(true));
    vapi.on("speech-end", () => setAgentSpeaking(false));
    vapi.on("volume-level", (lvl: number) => setVolume(lvl));

    vapi.on("message", (msg: any) => {
      if (msg?.type === "transcript" && msg?.transcriptType === "final") {
        setTranscript((prev) => [
          ...prev,
          { role: msg.role as "user" | "assistant", text: msg.transcript },
        ]);
      }
    });

    vapi.on("error", (e: any) => {
      toast({ title: "Call error", description: e?.message ?? String(e), variant: "destructive" });
      setCallState("idle");
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    });

    vapi.start(selectedAssistant, {
      variableValues: { customer_phone: number },
    } as any);
  }, [vapiConfig, selectedAssistant, number, toast]);

  const hangUp = useCallback(() => {
    vapiRef.current?.stop();
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    vapiRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const KEYS = [
    ["1", ""], ["2", "ABC"], ["3", "DEF"],
    ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
    ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
    ["*", ""], ["0", "+"], ["#", ""],
  ];

  const isActive = callState === "active";
  const isConnecting = callState === "connecting";
  const isEnded = callState === "ended";
  const inCall = isActive || isConnecting;

  const volBars = Array.from({ length: 8 }, (_, i) => i / 7 <= volume);

  return (
    <div className="space-y-4">
      {/* Status banner */}
      {!vapiConfig?.configured && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-amber-800 dark:text-amber-300">
            Vapi is not configured as your voice provider. Go to{" "}
            <a href="/integrations" className="underline font-medium">Integrations</a> → Voice AI (Vapi) and add
            both your <strong>api_key</strong> and <strong>public_key</strong>.
          </span>
        </div>
      )}
      {vapiConfig?.configured && !vapiConfig?.public_key && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-amber-800 dark:text-amber-300">
            Vapi public key not set — browser calling disabled. Add <strong>public_key</strong> in{" "}
            <a href="/integrations" className="underline font-medium">Integrations → Vapi</a>.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ── DIALPAD ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm">Dialpad</CardTitle>
                <CardDescription className="text-xs">
                  Live browser call via Vapi · Qwen3-235B AI
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => setShowSetup(true)}>
                <Star className="h-3.5 w-3.5 mr-1" /> Setup Assistant
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Tort agent quick-pick — dials with the tort's dedicated agent */}
            {activeTortAgents.length > 0 && (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Tort agent</Label>
                <Select onValueChange={selectTortAgent} disabled={inCall}>
                  <SelectTrigger className="text-xs h-8">
                    <SelectValue placeholder="Pick a tort's dedicated agent…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeTortAgents.map((a) => (
                      <SelectItem key={a.tort_id} value={a.tort_id} className="text-xs">
                        {a.tort_label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Assistant selector */}
            {vapiConfig?.assistants && vapiConfig.assistants.length > 0 && (
              <Select value={selectedAssistant} onValueChange={setSelectedAssistant} disabled={inCall}>
                <SelectTrigger className="text-xs h-8">
                  <SelectValue placeholder="Select assistant…" />
                </SelectTrigger>
                <SelectContent>
                  {vapiConfig.assistants.map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">
                      {a.name ?? a.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="+1 (555) 000-0000"
              className="text-center text-lg font-mono tracking-widest"
              disabled={inCall}
            />

            <div className="grid grid-cols-3 gap-2">
              {KEYS.map(([digit, sub]) => (
                <button
                  key={digit}
                  onClick={() => appendDigit(digit)}
                  disabled={inCall}
                  className="flex flex-col items-center justify-center h-14 rounded-lg border border-border bg-muted/40 hover:bg-muted/80 transition-colors active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <span className="text-lg font-semibold leading-none">{digit}</span>
                  <span className="text-[9px] text-muted-foreground tracking-widest mt-0.5">{sub}</span>
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={backspace} disabled={inCall}>
                <Delete className="h-4 w-4" />
              </Button>
              {!inCall ? (
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  disabled={number.length < 7 || !vapiConfig?.configured}
                  onClick={startCall}
                >
                  <Phone className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                  onClick={hangUp}
                >
                  <PhoneOff className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* ── ACTIVE CALL PANEL ── */}
            {(inCall || isEnded) && (
              <div className={`rounded-lg border p-3 space-y-3 transition-colors ${
                isEnded ? "border-gray-200 bg-gray-50 dark:bg-gray-900/30" :
                isActive ? "border-green-200 bg-green-50 dark:bg-green-950/20" :
                "border-blue-200 bg-blue-50 dark:bg-blue-950/20"
              }`}>
                {/* Status row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {isConnecting && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />}
                    {isActive && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                    {isEnded && <CheckCircle className="h-3.5 w-3.5 text-gray-500" />}
                    <span className={isActive ? "text-green-700 dark:text-green-400" : isEnded ? "text-gray-500" : "text-blue-700 dark:text-blue-400"}>
                      {isConnecting ? "Connecting…" : isActive ? `Live · ${number}` : "Call ended"}
                    </span>
                  </div>
                  {isActive && (
                    <span className="text-xs font-mono text-muted-foreground">{fmt(callDuration)}</span>
                  )}
                </div>

                {/* Volume meter */}
                {isActive && (
                  <div className="flex items-center gap-2">
                    <Volume2 className={`h-3.5 w-3.5 ${agentSpeaking ? "text-green-600 animate-pulse" : "text-muted-foreground"}`} />
                    <div className="flex gap-0.5 items-end h-4">
                      {volBars.map((lit, i) => (
                        <div
                          key={i}
                          style={{ height: `${40 + i * 8}%` }}
                          className={`w-1 rounded-sm transition-colors ${lit ? "bg-green-500" : "bg-muted"}`}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">{agentSpeaking ? "Agent speaking" : "Listening"}</span>
                  </div>
                )}

                {/* Controls */}
                {isActive && (
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant={muted ? "destructive" : "outline"}
                      onClick={toggleMute}
                    >
                      {muted ? <MicOff className="h-3.5 w-3.5 mr-1" /> : <Mic className="h-3.5 w-3.5 mr-1" />}
                      {muted ? "Unmute" : "Mute"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={hangUp}>
                      <PhoneOff className="h-3.5 w-3.5 mr-1 text-red-500" /> Hang Up
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── LIVE TRANSCRIPT ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Live Transcript</CardTitle>
            <CardDescription className="text-xs">Real-time speech-to-text during the call</CardDescription>
          </CardHeader>
          <CardContent>
            {transcript.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                <Headphones className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-xs">Transcript will appear here during a live call.</p>
                {!inCall && (
                  <p className="text-xs mt-1 opacity-60">Dial a number and press the green button to start.</p>
                )}
              </div>
            ) : (
              <div
                ref={transcriptRef}
                className="space-y-2 max-h-72 overflow-y-auto pr-1"
              >
                {transcript.map((line, i) => (
                  <div
                    key={i}
                    className={`flex gap-2 text-xs ${line.role === "assistant" ? "" : "flex-row-reverse"}`}
                  >
                    <div className={`rounded-lg px-2.5 py-1.5 max-w-[85%] ${
                      line.role === "assistant"
                        ? "bg-muted text-foreground"
                        : "bg-primary text-primary-foreground ml-auto"
                    }`}>
                      <span className={`block text-[10px] font-medium mb-0.5 opacity-60 ${line.role === "user" ? "text-right" : ""}`}>
                        {line.role === "assistant" ? "Agent" : "Lead"}
                      </span>
                      {line.text}
                    </div>
                  </div>
                ))}
                {agentSpeaking && (
                  <div className="flex gap-2 text-xs">
                    <div className="rounded-lg px-2.5 py-1.5 bg-muted">
                      <span className="block text-[10px] font-medium mb-0.5 opacity-60">Agent</span>
                      <span className="flex gap-1 items-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── SETUP ASSISTANT DIALOG ── */}
      <Dialog open={showSetup} onOpenChange={setShowSetup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Vapi Assistant</DialogTitle>
            <DialogDescription>
              Provisions a Vapi voice assistant powered by <strong>BitDeer · Qwen3-235B-A22B</strong>.
              Requires Vapi api_key in your integration vault.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Assistant Name</Label>
              <Input value={setupName} onChange={(e) => setSetupName(e.target.value)} placeholder="MTOS Intake Agent" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Voice</Label>
              <Select value={setupVoice} onValueChange={setSetupVoice}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                    <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
              <p><strong>LLM:</strong> Qwen/Qwen3-235B-A22B via BitDeer AI</p>
              <p><strong>STT:</strong> Deepgram Nova-2</p>
              <p><strong>TTS:</strong> OpenAI {setupVoice}</p>
              <p><strong>Recording:</strong> enabled</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSetup(false)}>Cancel</Button>
            <Button onClick={() => setupMut.mutate()} disabled={setupMut.isPending || !setupName}>
              {setupMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Create Assistant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── DNC ─────────────────────────────────────────────────────────────────────

function DncTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addNumber, setAddNumber] = useState("");
  const [addReason, setAddReason] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["dialer-dnc", search, page],
    queryFn: () => apiFetch<any>(`/dnc?page=${page}&search=${encodeURIComponent(search)}`),
  });

  const addMut = useMutation({
    mutationFn: () => apiFetch("/dnc", { method: "POST", body: JSON.stringify({ phone_number: addNumber.trim(), reason: addReason }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dialer-dnc"] }); setAddNumber(""); setAddReason(""); toast({ title: "Added to DNC" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkMut = useMutation({
    mutationFn: () => {
      const numbers = bulkText.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean);
      return apiFetch("/dnc/bulk", { method: "POST", body: JSON.stringify({ numbers, source: "scrub" }) });
    },
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["dialer-dnc"] }); setBulkText(""); setShowBulk(false); toast({ title: `Imported ${r.imported} numbers` }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/dnc/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dialer-dnc"] }),
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const entries: any[] = data?.dnc ?? [];
  const total: number = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add to DNC</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input value={addNumber} onChange={(e) => setAddNumber(e.target.value)} placeholder="+15551234567" className="max-w-[200px]" />
            <Input value={addReason} onChange={(e) => setAddReason(e.target.value)} placeholder="Reason (optional)" className="flex-1" />
            <Button disabled={!addNumber || addMut.isPending} onClick={() => addMut.mutate()}>
              {addMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              Add
            </Button>
            <Button variant="outline" onClick={() => setShowBulk(true)}>
              <Upload className="h-4 w-4 mr-1" /> Bulk Import
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search phone number…"
          className="max-w-xs"
        />
        <span className="text-sm text-muted-foreground">{total} total entries</span>
      </div>

      <Card>
        {isLoading ? (
          <CardContent className="py-12 text-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" /></CardContent>
        ) : entries.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-muted-foreground">No DNC entries{search ? " matching your search" : ""}.</CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Phone Number</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono">{e.phone_number}</TableCell>
                  <TableCell><Badge variant="outline">{e.source}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-xs">{e.reason ?? "—"}</TableCell>
                  <TableCell className="text-xs">{new Date(e.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-xs">{e.expires_at ? new Date(e.expires_at).toLocaleDateString() : "Never"}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" onClick={() => deleteMut.mutate(e.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {total > 50 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={entries.length < 50} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      <Dialog open={showBulk} onOpenChange={setShowBulk}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk DNC Import</DialogTitle>
            <DialogDescription>Paste numbers (one per line or comma-separated). Up to 5,000 at once.</DialogDescription>
          </DialogHeader>
          <Textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={10} placeholder="+15551234567&#10;+15559876543&#10;..." />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulk(false)}>Cancel</Button>
            <Button disabled={!bulkText.trim() || bulkMut.isPending} onClick={() => bulkMut.mutate()}>
              {bulkMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── SCRIPTS ─────────────────────────────────────────────────────────────────

const SECTION_TYPES = ["opening", "discovery", "pitch", "objection", "close", "custom"] as const;

function ScriptsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", category: "", content: { sections: [] as any[] }, is_active: true });

  const { data, isLoading } = useQuery({
    queryKey: ["dialer-scripts"],
    queryFn: () => apiFetch<any>("/scripts"),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof form) => apiFetch("/scripts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dialer-scripts"] }); setShowCreate(false); toast({ title: "Script created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/scripts/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dialer-scripts"] }); if (selected) setSelected(null); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const scripts: any[] = data?.scripts ?? [];

  const addSection = () => setForm((f) => ({
    ...f,
    content: { sections: [...f.content.sections, { title: "New Section", text: "", type: "custom" }] },
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{scripts.length} Script{scripts.length !== 1 ? "s" : ""}</p>
          <Button size="sm" onClick={() => setShowCreate(true)}><Plus className="h-3.5 w-3.5 mr-1" /> New</Button>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : scripts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No scripts yet.</p>
        ) : (
          <div className="space-y-1.5">
            {scripts.map((s: any) => (
              <div
                key={s.id}
                onClick={() => setSelected(s)}
                className={`rounded-lg border p-3 cursor-pointer transition-colors ${selected?.id === s.id ? "bg-primary/10 border-primary/30" : "hover:bg-muted/60"}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400 opacity-0 group-hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); if (confirm("Delete script?")) deleteMut.mutate(s.id); }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                {s.category && <p className="text-xs text-muted-foreground">{s.category}</p>}
                <p className="text-xs text-muted-foreground mt-0.5">{s.content?.sections?.length ?? 0} sections</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="md:col-span-2">
        {selected ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">{selected.name}</CardTitle>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400" onClick={() => { if (confirm("Delete?")) deleteMut.mutate(selected.id); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {(selected.content?.sections ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No sections in this script.</p>
              ) : (
                <div className="space-y-3">
                  {(selected.content.sections as any[]).map((sec: any, i: number) => (
                    <div key={i} className="rounded-lg border p-3 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs capitalize">{sec.type}</Badge>
                        <p className="text-sm font-semibold">{sec.title}</p>
                      </div>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{sec.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-20">
            Select a script to preview it
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Call Script</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Script Name *</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Mass Tort Intake Script" />
              </div>
              <div>
                <Label>Category</Label>
                <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="Intake, Follow-up…" />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Sections</Label>
                <Button size="sm" variant="outline" onClick={addSection}><Plus className="h-3 w-3 mr-1" /> Add Section</Button>
              </div>
              {(Array.isArray(form.content?.sections) ? form.content.sections : []).map((sec: any, i: number) => (
                <div key={i} className="border rounded-lg p-3 space-y-2 mb-2">
                  <div className="flex gap-2">
                    <Input value={sec.title} onChange={(e) => {
                      const secs = [...form.content.sections];
                      secs[i] = { ...secs[i], title: e.target.value };
                      setForm((f) => ({ ...f, content: { sections: secs } }));
                    }} placeholder="Section title" className="flex-1" />
                    <Select value={sec.type} onValueChange={(v) => {
                      const secs = [...form.content.sections];
                      secs[i] = { ...secs[i], type: v };
                      setForm((f) => ({ ...f, content: { sections: secs } }));
                    }}>
                      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>{SECTION_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-red-400" onClick={() => {
                      const secs = (Array.isArray(form.content?.sections) ? form.content.sections : []).filter((_, idx) => idx !== i);
                      setForm((f) => ({ ...f, content: { sections: secs } }));
                    }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                  <Textarea value={sec.text} rows={3} onChange={(e) => {
                    const secs = [...form.content.sections];
                    secs[i] = { ...secs[i], text: e.target.value };
                    setForm((f) => ({ ...f, content: { sections: secs } }));
                  }} placeholder="Script text for this section…" />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button disabled={!form.name || createMut.isPending} onClick={() => createMut.mutate(form)}>
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Create Script
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── RECORDINGS ───────────────────────────────────────────────────────────────

function RecordingsTab() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["dialer-recordings", page],
    queryFn: () => apiFetch<any>(`/recordings?page=${page}`),
  });
  const recs: any[] = data?.recordings ?? [];

  return (
    <div className="space-y-4">
      <Card>
        {isLoading ? (
          <CardContent className="py-12 text-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" /></CardContent>
        ) : recs.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-muted-foreground">No recordings available yet. Recordings appear after calls complete.</CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recording</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recs.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell className="font-mono text-xs">{r.from_number ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.to_number ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.duration_seconds != null ? `${Math.floor(r.duration_seconds / 60)}:${String(r.duration_seconds % 60).padStart(2, "0")}` : "—"}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell>
                    {r.recording_url ? (
                      <a href={r.recording_url} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="outline" className="h-7">
                          <Headphones className="h-3.5 w-3.5 mr-1" /> Play
                        </Button>
                      </a>
                    ) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {(recs.length === 25) && (
        <div className="flex justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────

function ReportsTab() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ["dialer-reports", days],
    queryFn: () => apiFetch<any>(`/reports?days=${days}`),
  });

  const byStatus: any[] = data?.by_status ?? [];
  const byDay: any[] = data?.by_day ?? [];
  const avgDuration = data?.avg_duration_seconds ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Label className="text-sm">Period</Label>
        <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v))}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 14, 30, 60, 90].map((d) => <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Avg Call Duration</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{Math.floor(avgDuration / 60)}:{String(avgDuration % 60).padStart(2, "0")}</p>
            <p className="text-xs text-muted-foreground">min:sec</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Total Calls</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{byStatus.reduce((sum, s) => sum + Number(s.count), 0)}</p>
            <p className="text-xs text-muted-foreground">last {days} days</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Connect Rate</CardTitle></CardHeader>
          <CardContent>
            {(() => {
              const total = byStatus.reduce((sum, s) => sum + Number(s.count), 0);
              const connected = byStatus.find((s) => s.status === "completed")?.count ?? 0;
              return (
                <>
                  <p className="text-2xl font-bold text-green-600">{total > 0 ? Math.round((Number(connected) / total) * 100) : 0}%</p>
                  <p className="text-xs text-muted-foreground">{connected} connected / {total} total</p>
                </>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">By Status</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (
              <div className="space-y-2">
                {byStatus.map((s: any) => {
                  const total = byStatus.reduce((sum: number, x: any) => sum + Number(x.count), 0);
                  const pct = total > 0 ? Math.round((Number(s.count) / total) * 100) : 0;
                  return (
                    <div key={s.status} className="flex items-center gap-3">
                      <span className="w-24 text-xs capitalize text-muted-foreground">{s.status}</span>
                      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                        <div className="h-2 bg-primary rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-medium w-8 text-right">{s.count}</span>
                    </div>
                  );
                })}
                {byStatus.length === 0 && <p className="text-sm text-muted-foreground">No call data in this period.</p>}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Daily Call Volume</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : byDay.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {byDay.slice(-14).map((d: any) => {
                  const maxCount = Math.max(...(Array.isArray(byDay) ? byDay : []).map((x: any) => Number(x.count)), 1);
                  const pct = Math.round((Number(d.count) / maxCount) * 100);
                  return (
                    <div key={d.day} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-24">{d.day?.slice(0, 10)}</span>
                      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                        <div className="h-1.5 bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs w-8 text-right">{d.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── VAPI AI TAB ──────────────────────────────────────────────────────────────

interface VapiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  action?: { tool: string; args: Record<string, unknown> };
  loading?: boolean;
}

const VAPI_AI_QUICK = [
  { label: "List Assistants", msg: "List all my Vapi assistants" },
  { label: "Phone Numbers", msg: "Show all Vapi phone numbers" },
  { label: "Recent Calls", msg: "Show my 10 most recent Vapi calls" },
  { label: "Active Campaigns", msg: "Show me active call campaigns" },
];

async function vapiMcpChat(message: string, token: string): Promise<{ reply: string; action?: { tool: string; args: Record<string, unknown> } }> {
  const res = await fetch("/api/vapi-mcp/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    return { reply: err.error ?? "Request failed" };
  }
  return res.json();
}

function VapiAiTab() {
  const { user } = useAuth();
  const token = getAccessToken() ?? "";
  const [messages, setMessages] = useState<VapiChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi! I'm the Vapi AI Manager. I can manage your Vapi assistants, phone numbers, and calls directly from chat.\n\nTry asking me to **list your assistants**, **show phone numbers**, or **create a new intake assistant** — I'll do it automatically using your configured API key.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput("");
    setSending(true);

    const userMsg: VapiChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
    const loadingMsg: VapiChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", loading: true };
    setMessages((prev) => [...prev, userMsg, loadingMsg]);

    const resp = await vapiMcpChat(trimmed, token);

    setMessages((prev) =>
      prev.map((m) =>
        m.id === loadingMsg.id
          ? { ...m, content: resp.reply, action: resp.action, loading: false }
          : m,
      ),
    );
    setSending(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-220px)] min-h-[500px]">
      {/* Sidebar */}
      <Card className="lg:col-span-1 flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            Quick Actions
          </CardTitle>
          <CardDescription className="text-xs">One-click Vapi commands</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 space-y-2">
          {VAPI_AI_QUICK.map((q) => (
            <Button
              key={q.label}
              variant="outline"
              size="sm"
              className="w-full justify-start text-left text-xs"
              onClick={() => send(q.msg)}
              disabled={sending}
            >
              <Zap className="h-3 w-3 mr-2 text-yellow-500 shrink-0" />
              {q.label}
            </Button>
          ))}
        </CardContent>
        <div className="p-3 border-t">
          <div className="rounded-md bg-muted/50 p-2 space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">How it works</p>
            <p className="text-[10px] text-muted-foreground">
              Add your Vapi API key in <span className="font-medium">Integrations → Voice AI → Vapi</span>.
              Once saved, this chat connects automatically — no other setup needed.
            </p>
          </div>
        </div>
      </Card>

      {/* Chat */}
      <Card className="lg:col-span-3 flex flex-col overflow-hidden">
        <CardHeader className="pb-2 border-b shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
                <Bot className="h-3.5 w-3.5 text-primary" />
              </div>
              Vapi AI Manager
            </CardTitle>
            <Badge variant="outline" className="text-[10px] gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
              MCP Connected
            </Badge>
          </div>
        </CardHeader>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "assistant" && (
                <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.loading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span className="text-xs">Calling Vapi MCP…</span>
                  </div>
                ) : (
                  <>
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                    {msg.action && (
                      <div className="mt-2 pt-2 border-t border-border/40">
                        <p className="text-[10px] text-muted-foreground font-mono">
                          ⚡ {msg.action.tool}({Object.keys(msg.action.args).length > 0 ? JSON.stringify(msg.action.args) : ""})
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
              {msg.role === "user" && (
                <div className="h-7 w-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-semibold">
                  {(user as any)?.name?.charAt(0)?.toUpperCase() ?? "U"}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t p-3 shrink-0">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
              placeholder="Ask Vapi AI Manager anything… e.g. 'Create an intake assistant for talc ovarian cancer'"
              className="text-sm"
              disabled={sending}
            />
            <Button size="sm" onClick={() => send(input)} disabled={sending || !input.trim()}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DialerPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Phone className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Internal Dialer</h1>
          <p className="text-xs text-muted-foreground">Enterprise outbound call center — campaigns, DNC, scripts, and live analytics</p>
        </div>
      </div>

      <Tabs defaultValue="dashboard" className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="dashboard" className="gap-1.5"><BarChart3 className="h-3.5 w-3.5" />Dashboard</TabsTrigger>
          <TabsTrigger value="campaigns" className="gap-1.5"><Play className="h-3.5 w-3.5" />Campaigns</TabsTrigger>
          <TabsTrigger value="manual" className="gap-1.5"><Phone className="h-3.5 w-3.5" />Manual Dial</TabsTrigger>
          <TabsTrigger value="scripts" className="gap-1.5"><FileText className="h-3.5 w-3.5" />Call Scripts</TabsTrigger>
          <TabsTrigger value="dnc" className="gap-1.5"><ShieldOff className="h-3.5 w-3.5" />DNC Manager</TabsTrigger>
          <TabsTrigger value="recordings" className="gap-1.5"><Headphones className="h-3.5 w-3.5" />Recordings</TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5"><TrendingUp className="h-3.5 w-3.5" />Reports</TabsTrigger>
          <TabsTrigger value="vapi-ai" className="gap-1.5"><Bot className="h-3.5 w-3.5" />Vapi AI</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard"><StatsTab /></TabsContent>
        <TabsContent value="campaigns"><CampaignsTab /></TabsContent>
        <TabsContent value="manual"><ManualDialTab /></TabsContent>
        <TabsContent value="scripts"><ScriptsTab /></TabsContent>
        <TabsContent value="dnc"><DncTab /></TabsContent>
        <TabsContent value="recordings"><RecordingsTab /></TabsContent>
        <TabsContent value="reports"><ReportsTab /></TabsContent>
        <TabsContent value="vapi-ai"><VapiAiTab /></TabsContent>
      </Tabs>
    </div>
  );
}
