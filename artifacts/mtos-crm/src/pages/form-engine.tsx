import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetFormConfigs,
  useValidateEmail,
  useValidateAddress,
  useRunBackgroundCheck,
  useRunLeadBackgroundCheck,
  useUpdateFormConfig,
  useAddCustomField,
  useRemoveCustomField,
  getGetFormConfigsQueryKey,
  FormConfig,
  CustomField
} from "@workspace/api-client-react";
import { Copy, Mail, MapPin, Search, Shield, CheckCircle2, XCircle, AlertTriangle, Info, Play, Pencil, Plus, Trash2, RefreshCw, ExternalLink, Scale, Lock, ShieldCheck, FileCheck2, UserCheck2, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StateCombobox } from "@/components/state-combobox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", 
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", 
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", 
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", 
  "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

function getStatusBadge(status: string | undefined) {
  switch (status) {
    case "clean":
      return <Badge className="bg-green-500/10 text-green-500 hover:bg-green-500/20 hover:text-green-600 border-green-500/20">Clean</Badge>;
    case "flagged":
      return <Badge className="bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-600 border-red-500/20">Flagged</Badge>;
    case "not_found":
      return <Badge className="bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 hover:text-yellow-600 border-yellow-500/20">Not Found</Badge>;
    case "error":
      return <Badge className="bg-gray-500/10 text-gray-500 hover:bg-gray-500/20 hover:text-gray-600 border-gray-500/20">Error</Badge>;
    default:
      return <Badge variant="outline">{status || "Unknown"}</Badge>;
  }
}

function SearchScopeBadge({ result }: { result: any }) {
  const scope = result?.search_scope as string | undefined;
  const stateLabel = result?.searched_state_label as string | null | undefined;
  const stateCode = result?.searched_state as string | null | undefined;
  const courts = (result?.searched_courts as string[] | undefined) || [];

  if (!scope) return null;

  let label: string;
  let tone: string;
  if (scope === "state" && stateLabel) {
    label = `Searched: ${stateLabel} federal courts (${courts.length})`;
    tone = "bg-blue-500/10 text-blue-700 border-blue-500/20";
  } else if (scope === "national-fallback") {
    label = `Searched: nationwide (state filter "${stateCode ?? ""}" not applied)`;
    tone = "bg-amber-500/10 text-amber-700 border-amber-500/20";
  } else {
    label = "Searched: nationwide federal courts";
    tone = "bg-muted text-muted-foreground border";
  }
  return (
    <Badge variant="outline" className={tone}>
      <MapPin className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}

function getSeverityBadge(severity: string | undefined) {
  switch (severity) {
    case "low":
      return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Low</Badge>;
    case "medium":
      return <Badge className="bg-orange-500/10 text-orange-500 border-orange-500/20">Medium</Badge>;
    case "high":
      return <Badge className="bg-red-500/10 text-red-500 border-red-500/20">High</Badge>;
    default:
      return <Badge variant="outline">{severity || "Unknown"}</Badge>;
  }
}

// ── PACER Federal Courts result block ──────────────────────────────────────
// Rendered inside the Manual Background Check card result block. Handles all
// four PCL outcomes: not configured, auth failed, source unreachable, and
// successful (0 or more cases).

interface PacerCase {
  caseNumberFull?: string | null;
  caseTitle?: string | null;
  caseYear?: number | null;
  courtId?: string | null;
  dateFiled?: string | null;
  jurisdictionType?: string | null;
  natureOfSuit?: string | null;
  docketUrl?: string | null;
}

interface PacerOutcome {
  ok: boolean;
  reason?: string | null;
  message?: string | null;
  cases?: PacerCase[];
  truncated?: boolean;
}

function PacerResultSection({ pacer }: { pacer?: PacerOutcome | null }) {
  if (pacer == null) return null;

  const headerClass = "flex items-center gap-2 px-4 py-2.5 border-t bg-slate-50 text-sm font-medium";

  if (!pacer.ok) {
    if (pacer.reason === "NOT_CONFIGURED") {
      return (
        <div className={`${headerClass} text-muted-foreground`}>
          <Scale className="h-4 w-4 shrink-0" />
          <span>
            PACER Federal Courts —{" "}
            <span className="font-normal">
              Not configured. Add PACER credentials in{" "}
              <span className="font-medium">Settings → Integrations</span> to enable
              federal court searches (per-page billing applies).
            </span>
          </span>
        </div>
      );
    }
    const label = pacer.reason === "AUTH_FAILED" ? "Credentials rejected" : "Service unreachable";
    return (
      <div className={`${headerClass} text-amber-700 bg-amber-50`}>
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>PACER Federal Courts — {label}{pacer.message ? `: ${pacer.message}` : ""}. Lane was not searched.</span>
      </div>
    );
  }

  const cases = pacer.cases ?? [];

  if (cases.length === 0) {
    return (
      <div className={`${headerClass} text-emerald-700 bg-emerald-50`}>
        <Scale className="h-4 w-4 shrink-0" />
        <span>PACER Federal Courts — No cases found for this name.</span>
      </div>
    );
  }

  return (
    <div className="border-t">
      <div className={`${headerClass} text-amber-800 bg-amber-50`}>
        <Scale className="h-4 w-4 shrink-0" />
        <span>
          PACER Federal Courts —{" "}
          <span className="font-semibold">{cases.length}{pacer.truncated ? "+" : ""} case{cases.length !== 1 ? "s" : ""} found</span>.{" "}
          Operator must confirm identity before treating as a match.
        </span>
      </div>
      <div className="divide-y">
        {cases.map((c, i) => (
          <div key={i} className="px-4 py-2.5 bg-white text-xs flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate text-amber-900" title={c.caseTitle ?? ""}>
                {c.caseTitle || "(untitled case)"}
              </div>
              <div className="font-mono text-muted-foreground mt-0.5">
                {c.caseNumberFull ?? "—"}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {[
                  c.courtId ? `Court: ${c.courtId}` : null,
                  c.jurisdictionType ?? null,
                  c.dateFiled ? `Filed: ${c.dateFiled}` : null,
                  c.natureOfSuit ? `Nature: ${c.natureOfSuit}` : null,
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
            {c.docketUrl && (
              <a
                href={c.docketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
              >
                Docket <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FormEngine() {
  const { toast } = useToast();
  
  // Data Fetching
  const { data: formConfigsData, isLoading: isLoadingConfigs } = useGetFormConfigs();
  const configs = formConfigsData?.tort_campaigns || [];

  // Mutations
  const validateEmail = useValidateEmail();
  const validateAddress = useValidateAddress();
  const runBackgroundCheck = useRunBackgroundCheck();
  const runLeadBackgroundCheck = useRunLeadBackgroundCheck();

  // States: Email
  const [emailInput, setEmailInput] = useState("");
  const [emailResult, setEmailResult] = useState<any>(null);

  // States: Address
  const [addressInput, setAddressInput] = useState({ street_address: "", city: "", state: "", zip: "" });
  const [addressResult, setAddressResult] = useState<any>(null);

  // States: Background Check (Manual)
  const [bgCheckInput, setBgCheckInput] = useState({ first_name: "", last_name: "", state: "", date_of_birth: "" });
  const [bgCheckResult, setBgCheckResult] = useState<any>(null);

  // States: Background Check (Lead)
  const [leadIdInput, setLeadIdInput] = useState("");
  const [leadBgCheckResult, setLeadBgCheckResult] = useState<any>(null);

  // Handlers
  const handleDownloadEmbedKit = () => {
    const origin = window.location.origin;
    const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const sections = configs.map((config: FormConfig) => {
      const embedCode = `<script src="${origin}/api/forms-public/embed/${config.id}"></script>\n<div id="mtos-form"></div>`;
      const standaloneHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${config.label} — Intake Form</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1rem; }
    .wrapper { width: 100%; max-width: 620px; }
  </style>
</head>
<body>
  <div class="wrapper">
    ${embedCode}
  </div>
</body>
</html>`;

      return { config, embedCode, standaloneHtml };
    });

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MTOS Intake Form Embed Kit</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: .25rem; }
    .meta { color: #64748b; font-size: .875rem; margin-bottom: 2rem; }
    .badge-row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 2.5rem; }
    .badge { display: inline-flex; align-items: center; gap: .375rem; border-radius: 9999px; border: 1px solid; padding: .25rem .75rem; font-size: .75rem; font-weight: 500; }
    .badge-green { border-color: #86efac; background: #f0fdf4; color: #15803d; }
    .badge-blue  { border-color: #93c5fd; background: #eff6ff; color: #1d4ed8; }
    .badge-purple{ border-color: #c4b5fd; background: #f5f3ff; color: #6d28d9; }
    .badge-amber { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
    .form-section { background: #fff; border: 1px solid #e2e8f0; border-radius: .75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
    .form-title { font-size: 1.125rem; font-weight: 600; margin-bottom: .25rem; }
    .form-id { font-family: monospace; font-size: .75rem; color: #94a3b8; margin-bottom: 1rem; }
    .label { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: .5rem; }
    pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: .5rem; padding: 1rem; font-size: .8rem; white-space: pre-wrap; word-break: break-all; margin-bottom: 1rem; }
    details { margin-top: .75rem; }
    summary { cursor: pointer; font-size: .8rem; color: #3b82f6; font-weight: 500; }
    .instructions { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: .5rem; padding: 1rem; font-size: .8rem; color: #1d4ed8; margin-top: .5rem; line-height: 1.6; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>MTOS Intake Form Embed Kit</h1>
  <p class="meta">Generated ${date} · ${origin} · ${sections.length} form${sections.length !== 1 ? "s" : ""}</p>

  <div class="badge-row">
    <span class="badge badge-green">✓ HIPAA Safe</span>
    <span class="badge badge-blue">🔒 End-to-End Encrypted</span>
    <span class="badge badge-purple">✓ TCPA Compliant</span>
    <span class="badge badge-amber">✓ TrustedForm Certified</span>
  </div>

  <h2>How to use on a Replit site</h2>
  <div class="instructions" style="margin-bottom:2rem">
    1. Pick a form below and copy the <strong>Embed Snippet</strong>.<br/>
    2. In your Replit site, open the HTML file you want the form to appear on.<br/>
    3. Paste the snippet where you want the form rendered — inside a <code>&lt;div&gt;</code> or anywhere in <code>&lt;body&gt;</code>.<br/>
    4. The form loads automatically. Submissions go directly into your MTOS lead pipeline.<br/>
    <br/>
    Or use the <strong>Standalone Page HTML</strong> to create a brand-new Replit site for a single form — just create an <code>index.html</code> and paste it in.
  </div>

  ${sections.map(({ config, embedCode, standaloneHtml }) => `
  <div class="form-section">
    <div class="form-title">${config.label}</div>
    <div class="form-id">${config.id}</div>

    <div class="label">Embed Snippet (paste into any existing page)</div>
    <pre>${embedCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>

    <details>
      <summary>▸ Show standalone page HTML (new Replit site)</summary>
      <pre style="margin-top:.75rem">${standaloneHtml.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
    </details>
  </div>`).join("")}
</body>
</html>`;

    const blob = new Blob([indexHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mtos-intake-embed-kit.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({ title: "Embed kit downloaded", description: `${configs.length} form${configs.length !== 1 ? "s" : ""} · open the HTML file to see all snippets.` });
  };

  const handleCopyEmbed = (configId: string) => {
    // Embed JS is served by the public router (forms-public.ts) — the
    // auth-gated /api/forms/* router intentionally does NOT mount
    // /embed/:tortId (see artifacts/api-server/src/routes/forms.ts L241-243
    // and the RBAC remediation in docs/audits/rbac-remediation-2026-04-26.md
    // §4). Pasting a snippet pointing at /api/forms/embed/* on a third-party
    // site would 401 in production / 404 in dev with auth bypass — both are
    // intentional. External embeds MUST use /api/forms-public/embed.
    const code = `<script src="${window.location.origin}/api/forms-public/embed/${configId}"></script>\n<div id="mtos-form"></div>`;
    navigator.clipboard.writeText(code);
    toast({
      title: "Copied to clipboard",
      description: "Embed code has been copied.",
    });
  };

  const handleValidateEmail = () => {
    if (!emailInput) return;
    validateEmail.mutate({ data: { email: emailInput } }, {
      onSuccess: (data) => setEmailResult(data),
      onError: () => toast({ title: "Error", description: "Failed to validate email", variant: "destructive" })
    });
  };

  const handleValidateAddress = () => {
    if (!addressInput.street_address || !addressInput.city || !addressInput.state || !addressInput.zip) {
      toast({ title: "Validation Error", description: "Please fill out all address fields.", variant: "destructive" });
      return;
    }
    validateAddress.mutate({ data: addressInput }, {
      onSuccess: (data) => setAddressResult(data),
      onError: () => toast({ title: "Error", description: "Failed to validate address", variant: "destructive" })
    });
  };

  const handleRunBgCheck = () => {
    if (!bgCheckInput.first_name || !bgCheckInput.last_name) {
      toast({ title: "Validation Error", description: "First and last name are required.", variant: "destructive" });
      return;
    }
    runBackgroundCheck.mutate({ data: bgCheckInput }, {
      onSuccess: (data) => setBgCheckResult(data),
      onError: () => toast({ title: "Error", description: "Failed to run background check", variant: "destructive" })
    });
  };

  const handleRunLeadBgCheck = () => {
    if (!leadIdInput || isNaN(Number(leadIdInput))) {
      toast({ title: "Validation Error", description: "Please enter a valid Lead ID.", variant: "destructive" });
      return;
    }
    runLeadBackgroundCheck.mutate({ id: Number(leadIdInput) }, {
      onSuccess: (data) => setLeadBgCheckResult(data),
      onError: () => toast({ title: "Error", description: "Failed to run background check for lead", variant: "destructive" })
    });
  };

  return (
    <div className="flex-1 space-y-8 p-8 pt-6 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold tracking-tight">Intake Form</h2>
          <p className="text-muted-foreground">
            Build and manage claimant-facing qualifying intake forms — every question is designed to drill down and determine true case eligibility.
          </p>
        </div>
      </div>

      {/* Security trust strip */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/8 px-3 py-1 text-xs font-medium text-green-700 dark:text-green-400">
          <ShieldCheck className="h-3.5 w-3.5" /> HIPAA Safe
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/8 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-400">
          <Lock className="h-3.5 w-3.5" /> End-to-End Encrypted
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/8 px-3 py-1 text-xs font-medium text-purple-700 dark:text-purple-400">
          <FileCheck2 className="h-3.5 w-3.5" /> TCPA Compliant
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/8 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          <Shield className="h-3.5 w-3.5" /> TrustedForm Certified
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-slate-400/30 bg-slate-500/8 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-400">
          <UserCheck2 className="h-3.5 w-3.5" /> Claimant Qualification Engine
        </div>
      </div>

      <Tabs defaultValue="builder" className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-8 max-w-2xl">
          <TabsTrigger value="builder">Intake Builder</TabsTrigger>
          <TabsTrigger value="validation">Claimant Validation</TabsTrigger>
          <TabsTrigger value="background">Background Check</TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">
                {configs.length > 0 ? `${configs.length} intake form${configs.length !== 1 ? "s" : ""} configured` : "No forms configured yet"}
              </p>
            </div>
            {configs.length > 0 && (
              <Button variant="outline" onClick={handleDownloadEmbedKit} className="gap-2">
                <Download className="h-4 w-4" />
                Download All Embed Codes
              </Button>
            )}
          </div>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {isLoadingConfigs ? (
              Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="border-border/50">
                  <CardHeader><Skeleton className="h-6 w-3/4" /></CardHeader>
                  <CardContent className="space-y-4">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                  </CardContent>
                </Card>
              ))
            ) : configs.length === 0 ? (
              <div className="col-span-full py-12 text-center text-muted-foreground bg-muted/20 rounded-lg border border-dashed">
                <p>No campaign configurations found.</p>
              </div>
            ) : (
              configs.map((config: FormConfig) => (
                <Card key={config.id} className="flex flex-col border-border/50 shadow-sm transition-all hover:shadow-md">
                  <CardHeader className="pb-4">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-xl">{config.label}</CardTitle>
                    </div>
                    <CardDescription className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary" className="font-mono text-xs">{config.id}</Badge>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 space-y-4">
                    {config.fields && config.fields.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Extra Fields</Label>
                        <div className="flex flex-wrap gap-1">
                          {config.fields.map(f => (
                            <Badge key={f} variant="outline" className="bg-muted/50 text-xs font-normal">{f}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {config.rules && config.rules.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Validation Rules</Label>
                        <ul className="text-sm space-y-1 text-muted-foreground">
                          {config.rules.map((rule, idx) => (
                            <li key={idx} className="flex items-start gap-2">
                              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-primary/60 shrink-0" />
                              <span className="leading-tight">{rule}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                  {config.custom_fields && config.custom_fields.length > 0 && (
                    <div className="px-6 pb-2">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom Fields</Label>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {config.custom_fields.map(cf => (
                          <Badge key={cf.key} variant="outline" className="bg-blue-500/5 text-blue-600 border-blue-500/30 text-xs font-normal">
                            {cf.label}{cf.required ? "*" : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <CardFooter className="bg-muted/20 border-t p-4 flex flex-col gap-2">
                    <div className="flex gap-2 w-full">
                      <FormPreviewDialog config={config} />
                      <Button variant="default" className="flex-1" size="sm" onClick={() => handleCopyEmbed(config.id)}>
                        <Copy className="h-4 w-4 mr-2" /> Embed
                      </Button>
                    </div>
                    <FormEditDialog config={config} />
                  </CardFooter>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="validation" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="border-border/50 shadow-sm flex flex-col">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-md text-primary">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Email Validator</CardTitle>
                    <CardDescription>Real-time inbox verification</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 flex-1">
                <div className="flex gap-2">
                  <Input 
                    placeholder="Enter email address..." 
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleValidateEmail()}
                  />
                  <Button onClick={handleValidateEmail} disabled={validateEmail.isPending}>
                    {validateEmail.isPending ? "Validating..." : "Validate"}
                  </Button>
                </div>

                {emailResult && (
                  <div className="mt-6 rounded-md border p-4 bg-muted/20 space-y-3 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-muted-foreground w-16">Status:</span>
                      {emailResult.valid ? (
                        <Badge className="bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20"><CheckCircle2 className="h-3 w-3 mr-1" /> Valid</Badge>
                      ) : (
                        <Badge className="bg-red-500/10 text-red-500 hover:bg-red-500/20 border-red-500/20"><XCircle className="h-3 w-3 mr-1" /> Invalid</Badge>
                      )}
                    </div>
                    
                    {!emailResult.valid && emailResult.errors && emailResult.errors.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-sm font-medium text-muted-foreground">Errors:</span>
                        <ul className="text-sm text-red-500/80 bg-red-500/10 p-3 rounded-md list-disc list-inside pl-6">
                          {emailResult.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
                        </ul>
                      </div>
                    )}
                    
                    {emailResult.suggestion && (
                      <div className="flex items-start gap-2 bg-blue-500/10 text-blue-600 p-3 rounded-md text-sm">
                        <Info className="h-4 w-4 mt-0.5 shrink-0" />
                        <div>
                          <span className="font-medium">Did you mean?</span> {emailResult.suggestion}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/50 shadow-sm flex flex-col">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-md text-primary">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Address Validator</CardTitle>
                    <CardDescription>USPS CASS certification check</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 flex-1">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Street Address</Label>
                    <Input 
                      placeholder="123 Main St" 
                      value={addressInput.street_address}
                      onChange={(e) => setAddressInput({...addressInput, street_address: e.target.value})}
                    />
                  </div>
                  <div className="grid grid-cols-6 gap-3">
                    <div className="col-span-3 space-y-1.5">
                      <Label className="text-xs">City</Label>
                      <Input 
                        placeholder="City"
                        value={addressInput.city}
                        onChange={(e) => setAddressInput({...addressInput, city: e.target.value})}
                      />
                    </div>
                    <div className="col-span-1 space-y-1.5">
                      <Label className="text-xs">State</Label>
                      <StateCombobox
                        value={addressInput.state}
                        onChange={(v) => setAddressInput({ ...addressInput, state: v })}
                        placeholder="ST"
                        triggerClassName="px-2"
                      />
                    </div>
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-xs">ZIP</Label>
                      <Input 
                        placeholder="12345"
                        value={addressInput.zip}
                        onChange={(e) => setAddressInput({...addressInput, zip: e.target.value})}
                      />
                    </div>
                  </div>
                  <Button className="w-full mt-2" onClick={handleValidateAddress} disabled={validateAddress.isPending}>
                    {validateAddress.isPending ? "Validating..." : "Validate Address"}
                  </Button>
                </div>

                {addressResult && (
                  <div className="mt-4 rounded-md border p-4 bg-muted/20 space-y-3 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-muted-foreground w-16">Status:</span>
                      {addressResult.valid ? (
                        <Badge className="bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20"><CheckCircle2 className="h-3 w-3 mr-1" /> Valid</Badge>
                      ) : (
                        <Badge className="bg-red-500/10 text-red-500 hover:bg-red-500/20 border-red-500/20"><XCircle className="h-3 w-3 mr-1" /> Invalid</Badge>
                      )}
                    </div>
                    
                    {!addressResult.valid && addressResult.errors && addressResult.errors.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-sm font-medium text-muted-foreground">Errors:</span>
                        <ul className="text-sm text-red-500/80 bg-red-500/10 p-3 rounded-md list-disc list-inside pl-6">
                          {addressResult.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="background" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="border-border/50 shadow-sm flex flex-col">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-md text-primary">
                    <Shield className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Manual Background Check</CardTitle>
                    <CardDescription>Search public records and legal histories</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>First Name</Label>
                    <Input 
                      placeholder="First Name" 
                      value={bgCheckInput.first_name}
                      onChange={(e) => setBgCheckInput({...bgCheckInput, first_name: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Last Name</Label>
                    <Input 
                      placeholder="Last Name" 
                      value={bgCheckInput.last_name}
                      onChange={(e) => setBgCheckInput({...bgCheckInput, last_name: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>State (Optional)</Label>
                    <Select value={bgCheckInput.state} onValueChange={(v) => setBgCheckInput({...bgCheckInput, state: v === "none" ? "" : v})}>
                      <SelectTrigger><SelectValue placeholder="Select State" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Any State</SelectItem>
                        {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Date of Birth (Optional)</Label>
                    <Input 
                      type="date"
                      value={bgCheckInput.date_of_birth}
                      onChange={(e) => setBgCheckInput({...bgCheckInput, date_of_birth: e.target.value})}
                    />
                  </div>
                </div>
                <Button className="w-full" onClick={handleRunBgCheck} disabled={runBackgroundCheck.isPending}>
                  {runBackgroundCheck.isPending ? "Running Check..." : "Run Background Check"}
                </Button>

                {bgCheckResult && (
                  <div className="mt-6 border rounded-lg overflow-hidden animate-in fade-in duration-300">
                    <div className="bg-muted/40 p-4 border-b space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">Status:</span>
                          {getStatusBadge(bgCheckResult.status)}
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">
                          Source: {bgCheckResult.source} • {new Date(bgCheckResult.checked_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm bg-background p-3 rounded border text-muted-foreground">
                        {bgCheckResult.summary}
                      </p>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <SearchScopeBadge result={bgCheckResult} />
                      </div>
                      {bgCheckResult.notes && bgCheckResult.notes.length > 0 && (
                        <ul className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
                          {bgCheckResult.notes.map((n: string, i: number) => (
                            <li key={i} className="flex gap-1.5">
                              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span>{n}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    
                    {/* ── Sources actually checked ── */}
                    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Sources checked:</span>
                      <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> Federal Courts (CourtListener / RECAP)</span>
                      <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> OFAC Sanctions (US Treasury SDN)</span>
                      {bgCheckResult.pacer?.ok && (
                        <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> PACER</span>
                      )}
                    </div>

                    {bgCheckResult.records && bgCheckResult.records.length > 0 && (
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableHead>Type</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Jurisdiction</TableHead>
                            <TableHead>Severity</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bgCheckResult.records.map((rec: any, i: number) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium text-xs">{rec.type}</TableCell>
                              <TableCell className="text-xs">{rec.description}</TableCell>
                              <TableCell className="text-xs whitespace-nowrap">{rec.date || "N/A"}</TableCell>
                              <TableCell className="text-xs">{rec.jurisdiction || "N/A"}</TableCell>
                              <TableCell>{getSeverityBadge(rec.severity)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}

                    {/* ── PACER: only show when it actually ran (configured + results) ── */}
                    {bgCheckResult.pacer && bgCheckResult.pacer.ok !== false && (
                      <PacerResultSection pacer={bgCheckResult.pacer} />
                    )}
                    {bgCheckResult.pacer?.ok === false && bgCheckResult.pacer.reason !== "NOT_CONFIGURED" && (
                      <PacerResultSection pacer={bgCheckResult.pacer} />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/50 shadow-sm flex flex-col h-fit">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-md text-primary">
                    <Search className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Check Existing Lead</CardTitle>
                    <CardDescription>Run screening on a lead already in the system</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input 
                    placeholder="Lead ID (e.g. 1234)" 
                    value={leadIdInput}
                    onChange={(e) => setLeadIdInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRunLeadBgCheck()}
                  />
                  <Button onClick={handleRunLeadBgCheck} disabled={runLeadBackgroundCheck.isPending}>
                    {runLeadBackgroundCheck.isPending ? "Checking..." : "Run Lead Check"}
                  </Button>
                </div>

                {leadBgCheckResult && (
                  <div className="mt-4 border rounded-lg overflow-hidden animate-in fade-in duration-300">
                    <div className="bg-muted/40 p-4 border-b space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">Status:</span>
                          {getStatusBadge(leadBgCheckResult.status)}
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">
                          {new Date(leadBgCheckResult.checked_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm bg-background p-3 rounded border text-muted-foreground">
                        {leadBgCheckResult.summary}
                      </p>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <SearchScopeBadge result={leadBgCheckResult} />
                      </div>
                      {leadBgCheckResult.notes && leadBgCheckResult.notes.length > 0 && (
                        <ul className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
                          {leadBgCheckResult.notes.map((n: string, i: number) => (
                            <li key={i} className="flex gap-1.5">
                              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span>{n}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    
                    {leadBgCheckResult.records && leadBgCheckResult.records.length > 0 && (
                      <ScrollArea className="h-[200px]">
                        <Table>
                          <TableHeader className="sticky top-0 bg-background z-10">
                            <TableRow className="bg-muted/20 hover:bg-muted/20">
                              <TableHead>Type</TableHead>
                              <TableHead>Severity</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {leadBgCheckResult.records.map((rec: any, i: number) => (
                              <TableRow key={i}>
                                <TableCell>
                                  <div className="font-medium text-xs">{rec.type}</div>
                                  <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{rec.description}</div>
                                </TableCell>
                                <TableCell>{getSeverityBadge(rec.severity)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FormPreviewDialog({ config }: { config: FormConfig }) {
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const apiBase = (import.meta.env.VITE_API_URL as string | undefined) || `${window.location.origin}/api`;
  // Preview HTML is served by the public router (forms-public.ts) — the
  // auth-gated /api/forms/* router intentionally does NOT mount /preview/:tortId
  // (see artifacts/api-server/src/routes/forms.ts L241-242 and the RBAC
  // remediation in docs/audits/rbac-remediation-2026-04-26.md §4). Hitting the
  // old /forms/preview path returns 401 (prod) / 404 (dev with auth bypass) —
  // both are intentional; the live preview must use /forms-public/preview.
  const previewSrc = `${apiBase.replace(/\/$/, "")}/forms-public/preview/${config.id}?k=${reloadKey}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="flex-1" size="sm">
          <Play className="h-4 w-4 mr-2" /> Preview
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[680px] h-[85vh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-2 shrink-0 flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <DialogTitle>Live Preview: {config.label}</DialogTitle>
            <DialogDescription>
              Embedded preview of the public intake form for this campaign. Submissions made here are not saved.
            </DialogDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)}>
            <RefreshCw className="h-4 w-4 mr-1" /> Reload
          </Button>
        </DialogHeader>
        <div className="flex-1 p-6 pt-0 min-h-0">
          {open && (
            <iframe
              key={reloadKey}
              src={previewSrc}
              title={`Preview of ${config.label} intake form`}
              className="w-full h-full border rounded-md bg-white"
              sandbox="allow-forms allow-scripts"
              referrerPolicy="no-referrer"
              data-testid={`iframe-preview-${config.id}`}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_TYPES: CustomField["type"][] = ["text", "email", "tel", "date", "number", "select", "textarea", "checkbox"];

function FormEditDialog({ config }: { config: FormConfig }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [diagnoses, setDiagnoses] = useState<string[]>(config.valid_diagnoses || []);
  const [diagInput, setDiagInput] = useState("");
  const [introText, setIntroText] = useState(config.intro_text || "");
  const [active, setActive] = useState(config.active !== false);
  const [avgSettlementLow, setAvgSettlementLow] = useState<string>(config.avg_settlement_low?.toString() ?? "");
  const [avgSettlementHigh, setAvgSettlementHigh] = useState<string>(config.avg_settlement_high?.toString() ?? "");
  const [mdlStatus, setMdlStatus] = useState<string>(config.mdl_status ?? "");
  const [solMonths, setSolMonths] = useState<string>(config.sol_months?.toString() ?? "");
  const [customFields, setCustomFields] = useState<CustomField[]>(config.custom_fields || []);
  const [newField, setNewField] = useState<CustomField>({ key: "", label: "", type: "text", required: false });

  const updateConfig = useUpdateFormConfig();
  const addField = useAddCustomField();
  const removeField = useRemoveCustomField();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetFormConfigsQueryKey() });

  const addDiagnosis = () => {
    const v = diagInput.trim().toLowerCase();
    if (!v || diagnoses.includes(v)) return;
    setDiagnoses([...diagnoses, v]);
    setDiagInput("");
  };

  const handleSaveBase = () => {
    updateConfig.mutate(
      { tortId: config.id, data: {
        valid_diagnoses: diagnoses,
        intro_text: introText || null,
        active,
        avg_settlement_low: avgSettlementLow === "" ? null : Number(avgSettlementLow),
        avg_settlement_high: avgSettlementHigh === "" ? null : Number(avgSettlementHigh),
        mdl_status: mdlStatus || null,
        sol_months: solMonths === "" ? null : Number(solMonths),
      } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Saved", description: `${config.label} updated.` });
        },
        onError: (err: Error) => toast({ title: "Save failed", description: err?.message || "Update failed", variant: "destructive" }),
      }
    );
  };

  const handleAddField = () => {
    const key = newField.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!key || !newField.label.trim()) {
      toast({ title: "Field invalid", description: "Key and label are required", variant: "destructive" });
      return;
    }
    if (customFields.some(f => f.key === key)) {
      toast({ title: "Duplicate key", description: `Key "${key}" already exists`, variant: "destructive" });
      return;
    }
    const field: CustomField = {
      ...newField,
      key,
      options: newField.type === "select"
        ? (newField.options && newField.options.length > 0 ? newField.options : ["Option 1"])
        : undefined,
    };
    addField.mutate(
      { tortId: config.id, data: field },
      {
        onSuccess: (data) => {
          invalidate();
          // Prefer server response when present; otherwise append locally.
          // Functional updater avoids stale closure issues.
          const fromServer = (data as { custom_fields?: CustomField[] } | undefined)?.custom_fields;
          if (fromServer) setCustomFields(fromServer);
          else setCustomFields(prev => [...prev, field]);
          setNewField({ key: "", label: "", type: "text", required: false });
          toast({ title: "Field added", description: field.label });
        },
        onError: (err: Error) => toast({ title: "Add failed", description: err?.message || "Failed to add field", variant: "destructive" }),
      }
    );
  };

  const handleRemoveField = (key: string) => {
    removeField.mutate(
      { tortId: config.id, key },
      {
        onSuccess: (data) => {
          invalidate();
          const fromServer = (data as { custom_fields?: CustomField[] } | undefined)?.custom_fields;
          if (fromServer) setCustomFields(fromServer);
          else setCustomFields(prev => prev.filter(f => f.key !== key));
          toast({ title: "Field removed" });
        },
        onError: (err: Error) => toast({ title: "Remove failed", description: err?.message, variant: "destructive" }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full" data-testid={`button-edit-${config.id}`}>
          <Pencil className="h-4 w-4 mr-2" /> Edit Form
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[720px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit: {config.label}</DialogTitle>
          <DialogDescription>
            Update intake form settings, intro text, valid diagnoses, and custom fields for this campaign.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Active</Label>
              <p className="text-xs text-muted-foreground">Inactive campaigns return 404 on embed.</p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} data-testid={`switch-active-${config.id}`} />
          </div>

          <div className="space-y-2">
            <Label>Form Intro Text</Label>
            <Textarea
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              placeholder="Optional intro shown at the top of the embedded form."
              rows={2}
              data-testid={`textarea-intro-${config.id}`}
            />
          </div>

          <div className="rounded-md border p-3 space-y-3 bg-muted/10">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Decision Engine inputs</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Avg settlement LOW ($)</Label>
                <Input type="number" value={avgSettlementLow} onChange={e => setAvgSettlementLow(e.target.value)} placeholder="e.g. 50000" data-testid={`input-settlement-low-${config.id}`} />
              </div>
              <div>
                <Label>Avg settlement HIGH ($)</Label>
                <Input type="number" value={avgSettlementHigh} onChange={e => setAvgSettlementHigh(e.target.value)} placeholder="e.g. 250000" data-testid={`input-settlement-high-${config.id}`} />
              </div>
              <div>
                <Label>MDL status</Label>
                <Select value={mdlStatus || "_none"} onValueChange={v => setMdlStatus(v === "_none" ? "" : v)}>
                  <SelectTrigger data-testid={`select-mdl-${config.id}`}><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— Unset —</SelectItem>
                    <SelectItem value="pre_mdl">Pre-MDL</SelectItem>
                    <SelectItem value="active_bellwether">Active bellwether</SelectItem>
                    <SelectItem value="settling">Settling</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>SOL window (months)</Label>
                <Input type="number" value={solMonths} onChange={e => setSolMonths(e.target.value)} placeholder="e.g. 24" data-testid={`input-sol-${config.id}`} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Used to score lead convexity and detect ruin flags.</p>
          </div>

          <div className="space-y-2">
            <Label>Valid Diagnoses (matched case-insensitively)</Label>
            <div className="flex gap-2">
              <Input
                value={diagInput}
                onChange={(e) => setDiagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDiagnosis(); }}}
                placeholder="e.g. non-hodgkin lymphoma"
                data-testid={`input-diagnosis-${config.id}`}
              />
              <Button type="button" onClick={addDiagnosis} variant="outline">Add</Button>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-2">
              {diagnoses.map((d) => (
                <Badge key={d} variant="secondary" className="gap-1.5">
                  {d}
                  <button type="button" onClick={() => setDiagnoses(diagnoses.filter(x => x !== d))} className="hover:text-red-500" aria-label={`Remove ${d}`}>
                    <XCircle className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {diagnoses.length === 0 && <span className="text-xs text-muted-foreground">No diagnoses configured.</span>}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Custom Fields</Label>
              <Badge variant="outline">{customFields.length} field(s)</Badge>
            </div>
            <div className="space-y-2">
              {customFields.map((f) => (
                <div key={f.key} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <div className="space-y-0.5">
                    <div className="font-medium">{f.label} {f.required && <span className="text-red-500">*</span>}</div>
                    <div className="text-xs text-muted-foreground font-mono">{f.key} · {f.type}{f.options ? ` (${f.options.length} options)` : ""}</div>
                  </div>
                  <Button type="button" size="icon" variant="ghost" onClick={() => handleRemoveField(f.key)} data-testid={`button-remove-field-${f.key}`}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
              {customFields.length === 0 && <p className="text-xs text-muted-foreground">No custom fields yet.</p>}
            </div>

            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Custom Field</div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Key (snake_case)" value={newField.key} onChange={(e) => setNewField({ ...newField, key: e.target.value })} data-testid="input-field-key" />
                <Input placeholder="Label" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value })} data-testid="input-field-label" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Select value={newField.type} onValueChange={(v) => setNewField({ ...newField, type: v as CustomField["type"] })}>
                  <SelectTrigger data-testid="select-field-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between rounded-md border bg-background px-3">
                  <Label className="text-sm">Required</Label>
                  <Switch checked={newField.required} onCheckedChange={(c) => setNewField({ ...newField, required: c })} data-testid="switch-field-required" />
                </div>
              </div>
              <Input placeholder="Placeholder (optional)" value={newField.placeholder || ""} onChange={(e) => setNewField({ ...newField, placeholder: e.target.value })} />
              {newField.type === "select" && (
                <Input
                  placeholder="Options comma-separated (e.g. Yes,No,Maybe)"
                  value={(newField.options || []).join(",")}
                  onChange={(e) => setNewField({ ...newField, options: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                />
              )}
              <Button type="button" onClick={handleAddField} disabled={addField.isPending} data-testid="button-add-field">
                <Plus className="h-4 w-4 mr-2" /> Add Field
              </Button>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={handleSaveBase} disabled={updateConfig.isPending} data-testid={`button-save-${config.id}`}>
              {updateConfig.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
