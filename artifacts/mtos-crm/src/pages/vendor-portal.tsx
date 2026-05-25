import { useState, useEffect, useCallback } from "react";
import { useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Copy, Check, ExternalLink, ClipboardList } from "lucide-react";
import { format } from "date-fns";
async function portalFetch(path: string) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
}

interface Campaign {
  id: string;
  label: string;
  form_url: string;
}

interface Stats {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
}

interface PortalInfo {
  vendor: { internal_code: string; status: string };
  campaigns: Campaign[];
  stats: Stats;
}

interface Submission {
  id: number;
  name: string;
  tort_type: string;
  status: string;
  created_at: string;
}

function statusColor(s: string) {
  if (s === "accepted" || s === "qualified" || s === "signed") return "default";
  if (s === "rejected" || s === "disqualified") return "destructive";
  return "secondary";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} className="gap-1.5 shrink-0">
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy Link"}
    </Button>
  );
}

function QRButton({ url, label }: { url: string; label: string }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(url)}&size=300x300&margin=2`;
  return (
    <a href={qrUrl} target="_blank" rel="noopener noreferrer">
      <Button variant="ghost" size="sm" className="gap-1.5 shrink-0 text-muted-foreground">
        <ExternalLink className="h-3.5 w-3.5" />
        QR Code
      </Button>
    </a>
  );
}

export default function VendorPortal() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefillFirst, setPrefillFirst] = useState("");
  const [prefillLast, setPrefillLast] = useState("");
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    portalFetch(`/api/vendor-portal/${token}`)
      .then((r) => r.json())
      .then((data) => {
        setInfo(data as PortalInfo);
        setLoading(false);
      })
      .catch(() => {
        setError("This portal link is invalid or has been deactivated.");
        setLoading(false);
      });
  }, [token]);

  const loadSubmissions = useCallback(() => {
    if (!token || subsLoading) return;
    setSubsLoading(true);
    portalFetch(`/api/vendor-portal/${token}/submissions`)
      .then((r) => r.json())
      .then((data) => {
        setSubmissions((data as { submissions: Submission[] }).submissions ?? []);
        setSubsLoading(false);
      })
      .catch(() => setSubsLoading(false));
  }, [token, subsLoading]);

  function buildLink(base: string) {
    const parts: string[] = [];
    if (prefillFirst.trim()) parts.push(`first_name=${encodeURIComponent(prefillFirst.trim())}`);
    if (prefillLast.trim()) parts.push(`last_name=${encodeURIComponent(prefillLast.trim())}`);
    return parts.length ? `${base}&${parts.join("&")}` : base;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="w-full max-w-2xl space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="text-4xl mb-4">🔒</div>
            <h2 className="text-lg font-semibold mb-2">Portal Unavailable</h2>
            <p className="text-muted-foreground text-sm">
              {error ?? "This portal link is invalid or has been deactivated. Contact your account manager for a new link."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <div className="bg-background border-b">
        <div className="max-w-3xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Lead Submission Portal</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Partner ID: <span className="font-mono font-medium">{info.vendor.internal_code}</span>
              </p>
            </div>
            <Badge variant={info.vendor.status === "active" ? "default" : "secondary"} className="capitalize">
              {info.vendor.status}
            </Badge>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: "Total Submitted", value: info.stats.total },
            { label: "Pending Review", value: info.stats.pending },
            { label: "Accepted", value: info.stats.accepted },
            { label: "Rejected", value: info.stats.rejected },
          ].map((s) => (
            <Card key={s.label} className="text-center">
              <CardContent className="pt-4 pb-4">
                <div className="text-2xl font-bold">{s.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="campaigns" onValueChange={(v) => v === "submissions" && loadSubmissions()}>
          <TabsList>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="submissions">My Submissions</TabsTrigger>
          </TabsList>

          {/* Campaigns tab */}
          <TabsContent value="campaigns" className="space-y-4 mt-4">
            {/* Pre-fill shortcut */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Pre-fill Applicant Name (optional)</CardTitle>
                <CardDescription className="text-xs">
                  Type the applicant's name to generate a link that pre-fills the form for them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    placeholder="First name"
                    value={prefillFirst}
                    onChange={(e) => setPrefillFirst(e.target.value)}
                    className="max-w-[160px]"
                  />
                  <Input
                    placeholder="Last name"
                    value={prefillLast}
                    onChange={(e) => setPrefillLast(e.target.value)}
                    className="max-w-[160px]"
                  />
                </div>
                {(prefillFirst || prefillLast) && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Links below now include this name. Copy any campaign link to share.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Campaign list */}
            {info.campaigns.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  No active campaigns available right now. Check back soon.
                </CardContent>
              </Card>
            ) : (
              info.campaigns.map((c) => (
                <Card key={c.id}>
                  <CardContent className="py-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{c.label}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                          {buildLink(c.form_url)}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <CopyButton text={buildLink(c.form_url)} />
                        <QRButton url={buildLink(c.form_url)} label={c.label} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}

            <Card className="bg-muted/50 border-dashed">
              <CardContent className="py-4 text-xs text-muted-foreground space-y-1">
                <p><strong>How to use:</strong> Copy any link above and share it however you like — text, email, WhatsApp, your own website.</p>
                <p>Click <strong>QR Code</strong> to open a scannable code your clients can use in person. Right-click → Save Image to download it.</p>
                <p>Every lead submitted through your links is automatically credited to your account.</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Submissions tab */}
          <TabsContent value="submissions" className="mt-4">
            {subsLoading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : submissions.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <ClipboardList className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">No submissions yet. Share a campaign link to get started.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="rounded-md border bg-background overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Campaign</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((s, i) => (
                      <tr key={s.id} className={i < submissions.length - 1 ? "border-b" : ""}>
                        <td className="px-4 py-3 font-medium">{s.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{s.tort_type}</td>
                        <td className="px-4 py-3">
                          <Badge variant={statusColor(s.status)} className="capitalize text-xs">
                            {s.status.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {format(new Date(s.created_at), "MMM d, yyyy")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
