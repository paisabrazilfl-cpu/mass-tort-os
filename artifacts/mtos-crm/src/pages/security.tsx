import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Shield, ShieldAlert, ShieldOff, ShieldCheck, Ban, Brain, RefreshCw, Trash2, KeyRound, Plus, Loader2, Smartphone } from "lucide-react";
import { format } from "date-fns";
import { apiFetchRaw } from "@/lib/api-fetch";
import { startRegistration } from "@simplewebauthn/browser";

interface SecurityAlert {
  id: number;
  type: string;
  severity: string;
  source_ip: string | null;
  user_agent: string | null;
  request_path: string | null;
  request_method: string | null;
  details: string;
  payload_sample: string | null;
  ai_analysis: string | null;
  status: string;
  blocked: boolean;
  created_at: string;
}

interface BlockedIp {
  id: number;
  ip: string;
  reason: string;
  blocked_until: string | null;
  auto_blocked: boolean;
  alert_count: number;
  created_at: string;
}

interface SecurityStats {
  threat_level: string;
  total_alerts_24h: number;
  critical_alerts_24h: number;
  alerts_last_hour: number;
  blocked_ips: number;
  by_severity: { severity: string; count: number }[];
  by_type: { type: string; count: number }[];
}

interface Passkey {
  id: number;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

const severityColor: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-blue-400 text-white",
};

const threatLevelConfig: Record<string, { icon: typeof ShieldAlert; color: string; bg: string; label: string }> = {
  critical: { icon: ShieldOff, color: "text-red-600", bg: "bg-red-50 border-red-200", label: "CRITICAL THREAT" },
  high: { icon: ShieldAlert, color: "text-orange-600", bg: "bg-orange-50 border-orange-200", label: "HIGH THREAT" },
  elevated: { icon: Shield, color: "text-yellow-600", bg: "bg-yellow-50 border-yellow-200", label: "ELEVATED" },
  normal: { icon: ShieldCheck, color: "text-green-600", bg: "bg-green-50 border-green-200", label: "NORMAL" },
};

export default function Security() {
  const { toast } = useToast();
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [blockedIps, setBlockedIps] = useState<BlockedIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockIp, setBlockIp] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [blockDuration, setBlockDuration] = useState("24");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [analysisDialogOpen, setAnalysisDialogOpen] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const fetchPasskeys = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/auth/passkey/credentials");
      if (!res.ok) return;
      const data = (await res.json()) as { passkeys?: Passkey[] };
      setPasskeys(Array.isArray(data.passkeys) ? data.passkeys : []);
    } catch {
      /* non-fatal — the card just shows empty */
    }
  }, []);

  const addPasskey = useCallback(async () => {
    setPasskeyBusy(true);
    try {
      const optRes = await apiFetchRaw("/api/auth/passkey/register/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!optRes.ok) {
        toast({ title: "Couldn't start passkey setup", variant: "destructive" });
        return;
      }
      const { challengeId, options } = (await optRes.json()) as {
        challengeId: string;
        options: unknown;
      };
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: options as never });
      } catch {
        toast({ title: "Passkey setup cancelled" });
        return;
      }
      const deviceName = `Passkey · ${format(new Date(), "MMM d, yyyy")}`;
      const verRes = await apiFetchRaw("/api/auth/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: attestation, deviceName }),
      });
      if (!verRes.ok) {
        const b = (await verRes.json().catch(() => ({}))) as { error?: string };
        toast({
          title: "Couldn't add passkey",
          description: b.error || "Please try again.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Passkey added", description: "You can now sign in with this device." });
      fetchPasskeys();
    } catch {
      toast({ title: "Couldn't add passkey", variant: "destructive" });
    } finally {
      setPasskeyBusy(false);
    }
  }, [toast, fetchPasskeys]);

  const removePasskey = useCallback(
    async (id: number) => {
      try {
        const res = await apiFetchRaw(`/api/auth/passkey/credentials/${id}`, { method: "DELETE" });
        if (!res.ok) {
          toast({ title: "Couldn't remove passkey", variant: "destructive" });
          return;
        }
        toast({ title: "Passkey removed" });
        fetchPasskeys();
      } catch {
        toast({ title: "Couldn't remove passkey", variant: "destructive" });
      }
    },
    [toast, fetchPasskeys],
  );

  useEffect(() => {
    fetchPasskeys();
  }, [fetchPasskeys]);

  // ── Phone number (SMS-code sign-in) ───────────────────────────────────────
  const [phoneInfo, setPhoneInfo] = useState<{ phone: string | null; verified: boolean }>({
    phone: null,
    verified: false,
  });
  const [phoneStep, setPhoneStep] = useState<"idle" | "enter" | "code">("idle");
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);

  const fetchPhone = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/auth/phone");
      if (!res.ok) return;
      const d = (await res.json()) as { phone?: string | null; verified?: boolean };
      setPhoneInfo({ phone: d.phone ?? null, verified: Boolean(d.verified) });
    } catch {
      /* non-fatal */
    }
  }, []);

  const sendPhoneCode = useCallback(async () => {
    setPhoneBusy(true);
    try {
      const res = await apiFetchRaw("/api/auth/phone/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneInput }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast({
          title: "Couldn't send code",
          description: b.error || "Check the number and try again.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Code sent", description: "Enter the 6-digit code we just texted you." });
      setPhoneCode("");
      setPhoneStep("code");
    } catch {
      toast({ title: "Couldn't send code", variant: "destructive" });
    } finally {
      setPhoneBusy(false);
    }
  }, [phoneInput, toast]);

  const verifyPhoneCode = useCallback(async () => {
    setPhoneBusy(true);
    try {
      const res = await apiFetchRaw("/api/auth/phone/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: phoneCode }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast({
          title: "Couldn't verify",
          description: b.error || "That code is invalid or has expired.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Phone verified", description: "You can now sign in with a text code." });
      setPhoneStep("idle");
      setPhoneInput("");
      setPhoneCode("");
      fetchPhone();
    } catch {
      toast({ title: "Couldn't verify", variant: "destructive" });
    } finally {
      setPhoneBusy(false);
    }
  }, [phoneCode, toast, fetchPhone]);

  const removePhone = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/auth/phone", { method: "DELETE" });
      if (!res.ok) {
        toast({ title: "Couldn't remove phone", variant: "destructive" });
        return;
      }
      toast({ title: "Phone removed" });
      fetchPhone();
    } catch {
      toast({ title: "Couldn't remove phone", variant: "destructive" });
    }
  }, [toast, fetchPhone]);

  useEffect(() => {
    fetchPhone();
  }, [fetchPhone]);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, alertsRes, blockedRes] = await Promise.all([
        apiFetchRaw("/api/security/stats"),
        apiFetchRaw("/api/security/alerts?limit=50"),
        apiFetchRaw("/api/security/blocked-ips"),
      ]);
      setStats(await statsRes.json());
      setAlerts(await alertsRes.json());
      setBlockedIps(await blockedRes.json());
    } catch {
      toast({ title: "Failed to load security data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleBlockIp = async () => {
    if (!blockIp || !blockReason) return;
    try {
      await apiFetchRaw("/api/security/block-ip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: blockIp, reason: blockReason, duration_hours: parseInt(blockDuration) }),
      });
      toast({ title: "IP blocked" });
      setBlockDialogOpen(false);
      setBlockIp("");
      setBlockReason("");
      fetchData();
    } catch {
      toast({ title: "Failed to block IP", variant: "destructive" });
    }
  };

  const handleUnblockIp = async (ip: string) => {
    try {
      await apiFetchRaw(`/api/security/blocked-ips/${encodeURIComponent(ip)}`, { method: "DELETE" });
      toast({ title: "IP unblocked" });
      fetchData();
    } catch {
      toast({ title: "Failed to unblock IP", variant: "destructive" });
    }
  };

  const handleDismiss = async (id: number) => {
    try {
      await apiFetchRaw(`/api/security/alerts/${id}/dismiss`, { method: "PATCH" });
      fetchData();
    } catch {
      toast({ title: "Failed to dismiss alert", variant: "destructive" });
    }
  };

  const handleAiAnalysis = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetchRaw("/api/security/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setAnalysisResult(data);
      setAnalysisDialogOpen(true);
      fetchData();
    } catch {
      toast({ title: "AI analysis failed", variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const tlConfig = threatLevelConfig[stats?.threat_level || "normal"];
  const ThreatIcon = tlConfig.icon;

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Security Center</h1>
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Security Center</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={fetchData}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={handleAiAnalysis} disabled={analyzing}>
            <Brain className="mr-2 h-4 w-4" />
            {analyzing ? "Analyzing..." : "AI Threat Analysis"}
          </Button>
          <Button variant="destructive" onClick={() => setBlockDialogOpen(true)}>
            <Ban className="mr-2 h-4 w-4" />
            Block IP
          </Button>
        </div>
      </div>

      <Card className={`border-2 ${tlConfig.bg}`}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <ThreatIcon className={`h-12 w-12 ${tlConfig.color}`} />
            <div>
              <div className={`text-2xl font-bold ${tlConfig.color}`}>{tlConfig.label}</div>
              <div className="text-sm text-muted-foreground">
                {stats?.total_alerts_24h || 0} alerts in the last 24 hours
                {stats?.critical_alerts_24h ? ` (${stats.critical_alerts_24h} critical)` : ""}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Passkeys
              </CardTitle>
              <CardDescription>
                Sign in with Face ID, Touch ID, Windows Hello, or a security key — no password.
              </CardDescription>
            </div>
            <Button onClick={addPasskey} disabled={passkeyBusy}>
              {passkeyBusy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {passkeyBusy ? "Setting up…" : "Add passkey"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {passkeys.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              <KeyRound className="mx-auto mb-2 h-10 w-10 opacity-40" />
              <div className="font-medium">No passkeys yet</div>
              <div className="text-sm">Add one to sign in without a password.</div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {passkeys.map((pk) => (
                  <TableRow key={pk.id}>
                    <TableCell className="font-medium">{pk.device_name || "Passkey"}</TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(pk.created_at), "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {pk.last_used_at ? format(new Date(pk.last_used_at), "yyyy-MM-dd HH:mm") : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => removePasskey(pk.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Phone number
          </CardTitle>
          <CardDescription>
            Verify a mobile number to enable one-time text-code sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {phoneInfo.verified ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Badge className="bg-green-600 text-white">VERIFIED</Badge>
                <span className="font-mono">{phoneInfo.phone}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={removePhone}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : phoneStep === "idle" ? (
            <Button
              onClick={() => {
                setPhoneInput("");
                setPhoneStep("enter");
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add a phone number
            </Button>
          ) : phoneStep === "enter" ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="pk-phone">Phone number</Label>
                <Input
                  id="pk-phone"
                  placeholder="+1 555 123 4567"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                />
              </div>
              <Button onClick={sendPhoneCode} disabled={phoneBusy || !phoneInput.trim()}>
                {phoneBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send code
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="pk-code">6-digit code</Label>
                <Input
                  id="pk-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              <Button onClick={verifyPhoneCode} disabled={phoneBusy || phoneCode.length !== 6}>
                {phoneBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Verify
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Alerts (24h)</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.total_alerts_24h || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Critical (24h)</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-red-600">{stats?.critical_alerts_24h || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Last Hour</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.alerts_last_hour || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Blocked IPs</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-orange-600">{stats?.blocked_ips || 0}</div></CardContent>
        </Card>
      </div>

      {stats && (stats.by_type.length > 0 || stats.by_severity.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>By Attack Type</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {stats.by_type.map((t) => (
                  <div key={t.type} className="flex items-center justify-between">
                    <span className="text-sm font-mono">{t.type.replace(/_/g, " ")}</span>
                    <Badge variant="outline">{t.count}</Badge>
                  </div>
                ))}
                {stats.by_type.length === 0 && <div className="text-sm text-muted-foreground">No attacks detected</div>}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>By Severity</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {stats.by_severity.map((s) => (
                  <div key={s.severity} className="flex items-center justify-between">
                    <Badge className={severityColor[s.severity] || ""}>{s.severity.toUpperCase()}</Badge>
                    <span className="font-bold">{s.count}</span>
                  </div>
                ))}
                {stats.by_severity.length === 0 && <div className="text-sm text-muted-foreground">No alerts</div>}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {blockedIps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Blocked IPs</CardTitle>
            <CardDescription>Currently blocked IP addresses</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IP Address</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Blocked Until</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Alerts</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blockedIps.map((ip) => (
                  <TableRow key={ip.id}>
                    <TableCell className="font-mono font-bold">{ip.ip}</TableCell>
                    <TableCell className="max-w-[300px] truncate">{ip.reason}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {ip.blocked_until ? format(new Date(ip.blocked_until), "yyyy-MM-dd HH:mm") : "Permanent"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ip.auto_blocked ? "destructive" : "secondary"}>
                        {ip.auto_blocked ? "AUTO" : "MANUAL"}
                      </Badge>
                    </TableCell>
                    <TableCell>{ip.alert_count}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => handleUnblockIp(ip.ip)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Security Alerts</CardTitle>
          <CardDescription>Last 50 security events detected by the IDS</CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ShieldCheck className="h-12 w-12 mx-auto mb-3 text-green-500" />
              <div className="text-lg font-medium">All Clear</div>
              <div>No security alerts detected. The system is being monitored.</div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source IP</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => (
                  <TableRow key={alert.id} className={alert.severity === "critical" ? "bg-red-50" : ""}>
                    <TableCell>
                      <Badge className={severityColor[alert.severity] || ""}>
                        {alert.severity.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{alert.type.replace(/_/g, " ")}</TableCell>
                    <TableCell className="font-mono text-sm">{alert.source_ip || "—"}</TableCell>
                    <TableCell className="font-mono text-xs max-w-[150px] truncate">
                      {alert.request_method} {alert.request_path}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm">{alert.details}</TableCell>
                    <TableCell>
                      <Badge variant={
                        alert.status === "new" ? "outline" :
                        alert.status === "analyzed" ? "secondary" :
                        "default"
                      }>
                        {alert.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {format(new Date(alert.created_at), "yyyy-MM-dd HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      {alert.status === "new" && (
                        <Button variant="ghost" size="sm" onClick={() => handleDismiss(alert.id)}>
                          Dismiss
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={blockDialogOpen} onOpenChange={setBlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block IP Address</DialogTitle>
            <DialogDescription>Manually block an IP address from accessing the system.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>IP Address</Label>
              <Input placeholder="192.168.1.1" value={blockIp} onChange={(e) => setBlockIp(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Reason</Label>
              <Input placeholder="Suspicious activity" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Duration (hours)</Label>
              <Input type="number" value={blockDuration} onChange={(e) => setBlockDuration(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBlockIp} disabled={!blockIp || !blockReason}>
              Block IP
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={analysisDialogOpen} onOpenChange={setAnalysisDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>AI Threat Analysis</DialogTitle>
            <DialogDescription>AI-powered analysis of recent security events.</DialogDescription>
          </DialogHeader>
          {analysisResult?.analysis ? (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2">
                <Badge className={severityColor[analysisResult.analysis.threat_level] || ""}>
                  {analysisResult.analysis.threat_level?.toUpperCase()}
                </Badge>
                <span className="font-medium">{analysisResult.analysis.attack_type}</span>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-1">Summary</div>
                <div className="text-sm">{analysisResult.analysis.summary}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-1">Recommended Action</div>
                <div className="text-sm font-medium">{analysisResult.analysis.recommended_action}</div>
              </div>
              {analysisResult.analysis.indicators?.length > 0 && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-1">Indicators</div>
                  <ul className="list-disc pl-4 text-sm space-y-1">
                    {analysisResult.analysis.indicators.map((ind: string, i: number) => (
                      <li key={i}>{ind}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Analyzed {analysisResult.alert_count} alert(s) 
                {analysisResult.analysis.is_automated ? " - Automated attack detected" : ""}
              </div>
            </div>
          ) : (
            <div className="py-4 text-center text-muted-foreground">
              {analysisResult?.message || "No threats to analyze."}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setAnalysisDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
