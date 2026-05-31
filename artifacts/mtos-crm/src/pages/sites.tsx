import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Grid3x3,
  Plus,
  ExternalLink,
  Trash2,
  Sparkles,
  Lock,
  Loader2,
  CheckCircle2,
  XCircle,
  Users,
  ChevronRight,
  ChevronLeft,
  Globe,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";
import { apiFetchRaw, describeError } from "@/lib/api-fetch";
import { Skeleton } from "@/components/ui/skeleton";

// ─────────────────────────────────────────────────────────────────────────
// Types — mirror the /api/sites response shape.
// ─────────────────────────────────────────────────────────────────────────

interface SiteRow {
  slug: string;
  label: string;
  category: string;
  active: boolean;
  web_form_enabled: boolean;
  has_web_form: boolean;
  live: boolean;
  field_count: number;
  rule_count: number;
  lead_count: number;
  landing_url: string | null;
  intake_url: string | null;
  updated_at: string;
}

interface ScaffoldField {
  key: string;
  label: string;
  type: string;
  section: string;
  required: boolean;
  options?: string[];
  helper_text?: string;
}

interface ScaffoldRule {
  id: string;
  field: string;
  op: string;
  value: string | number | string[];
  message: string;
}

interface ScaffoldProposal {
  decision: "QUALIFIED" | "REVIEW" | "REJECTED";
  confidence: number;
  reasons: string[];
  customFields: ScaffoldField[];
  eligibilityRules?: ScaffoldRule[];
  eligibilityChecklist?: string[];
  severityTiers?: string[];
  statuteHint?: string | null;
  seo?: { title?: string; description?: string; keywords?: string[] };
}

const CANONICAL_GUARDRAILS = [
  "10 base intake fields (contact + eligibility)",
  "10 base validation & anti-fraud rules",
  "Not-a-law-firm positioning",
  "[COMPANY] disclaimer (footer + above submit)",
  "TCPA consent + TrustedForm",
];

const WIZARD_STEPS = ["Basics", "AI Scaffold", "Review Fields", "Guardrails", "Publish"] as const;

export default function SitesPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function loadSites() {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/sites");
      if (!res.ok) throw new Error(`Failed to load sites (${res.status})`);
      const data = (await res.json()) as { sites: SiteRow[]; categories: string[] };
      setSites(data.sites ?? []);
      setCategories(data.categories ?? []);
    } catch (err) {
      toast({ title: "Could not load sites", description: describeError(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleEnabled(site: SiteRow, next: boolean) {
    try {
      const res = await apiFetchRaw(`/api/sites/${encodeURIComponent(site.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web_form_enabled: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Update failed (${res.status})`);
      }
      toast({ title: next ? "Intake opened" : "Intake closed", description: site.label });
      void loadSites();
    } catch (err) {
      toast({ title: "Toggle failed", description: describeError(err), variant: "destructive" });
    }
  }

  async function softDelete(site: SiteRow) {
    if (!confirm(`Soft-delete "${site.label}"? The public intake will return 403 and the landing page will be hidden. Existing leads and audit history are kept.`)) {
      return;
    }
    try {
      const res = await apiFetchRaw(`/api/sites/${encodeURIComponent(site.slug)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Delete failed (${res.status})`);
      }
      toast({ title: "Site soft-deleted", description: site.label });
      void loadSites();
    } catch (err) {
      toast({ title: "Delete failed", description: describeError(err), variant: "destructive" });
    }
  }

  async function reactivate(site: SiteRow) {
    try {
      const res = await apiFetchRaw(`/api/sites/${encodeURIComponent(site.slug)}?reactivate=1`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Reactivate failed (${res.status})`);
      }
      toast({ title: "Site reactivated", description: site.label });
      void loadSites();
    } catch (err) {
      toast({ title: "Reactivate failed", description: describeError(err), variant: "destructive" });
    }
  }

  const liveCount = useMemo(() => sites.filter(s => s.live).length, [sites]);
  const totalLeads = useMemo(() => sites.reduce((n, s) => n + s.lead_count, 0), [sites]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Grid3x3 className="h-6 w-6 text-violet-600" /> Sites
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every tort campaign site — a live landing page plus a compliant intake form generated
            from the canonical form engine. Spin up a new one with the Site Maker wizard.
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Site
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Total sites" value={sites.length} icon={<Globe className="h-4 w-4" />} />
        <StatCard label="Live" value={liveCount} icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} />
        <StatCard label="Leads captured" value={totalLeads} icon={<Users className="h-4 w-4" />} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tort sites</CardTitle>
          <CardDescription>
            Toggle a site closed to flip its public intake to a clean 403; the landing page hides
            its CTA. Open the live links to view exactly what a claimant sees.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              No sites yet. Click <strong>New Site</strong> to generate your first tort campaign.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tort</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead>Live links</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map(site => (
                  <TableRow key={site.slug}>
                    <TableCell>
                      <div className="font-medium">{site.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {site.field_count} fields · {site.rule_count} rules
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{site.category}</Badge>
                    </TableCell>
                    <TableCell>
                      {site.active ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={site.web_form_enabled}
                            onCheckedChange={(v) => toggleEnabled(site, v)}
                          />
                          {site.live ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Live
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                              <XCircle className="h-3.5 w-3.5" /> Closed
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                          <Trash2 className="h-3.5 w-3.5" /> Deleted
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{site.lead_count}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-xs">
                        {site.landing_url && (
                          <a href={site.landing_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-600 hover:underline">
                            <ExternalLink className="h-3 w-3" /> Landing
                          </a>
                        )}
                        {site.intake_url && (
                          <a href={site.intake_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-600 hover:underline">
                            <ExternalLink className="h-3 w-3" /> Intake
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {site.active ? (
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => softDelete(site)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="gap-1 text-emerald-600 hover:text-emerald-600" onClick={() => reactivate(site)}>
                          <RotateCcw className="h-4 w-4" /> Reactivate
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

      <SiteMakerWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        categories={categories}
        onCreated={() => { setWizardOpen(false); void loadSites(); }}
      />
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold tabular-nums">{value}</div>
        </div>
        <div className="rounded-md bg-muted p-2">{icon}</div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Site Maker — 5-step wizard.
// ─────────────────────────────────────────────────────────────────────────

function SiteMakerWizard({
  open,
  onClose,
  categories,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);

  // Step 1 — basics
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState("");
  const [headline, setHeadline] = useState("");
  const [subhead, setSubhead] = useState("");
  const [introText, setIntroText] = useState("");

  // Step 2/3 — AI scaffold (tri-state proposal, never auto-committed)
  const [scaffolding, setScaffolding] = useState(false);
  const [proposal, setProposal] = useState<ScaffoldProposal | null>(null);
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set());

  // Step 5 — publish
  const [publishing, setPublishing] = useState(false);

  function reset() {
    setStep(0);
    setDisplayName("");
    setCategory("");
    setHeadline("");
    setSubhead("");
    setIntroText("");
    setProposal(null);
    setAcceptedKeys(new Set());
    setScaffolding(false);
    setPublishing(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function runScaffold() {
    if (!displayName.trim() || !category) {
      toast({ title: "Add a tort name and category first", variant: "destructive" });
      return;
    }
    setScaffolding(true);
    setProposal(null);
    try {
      const res = await apiFetchRaw("/api/sites/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim(), category }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || `Scaffold failed (${res.status})`);
      }
      const p = body.proposal as ScaffoldProposal;
      setProposal(p);
      // The proposal is NEVER auto-committed. Every field starts unchecked so
      // the operator must explicitly confirm each AI-suggested question before
      // it is added — regardless of the model's decision/confidence.
      setAcceptedKeys(new Set());
    } catch (err) {
      toast({ title: "AI scaffold failed", description: describeError(err), variant: "destructive" });
    } finally {
      setScaffolding(false);
    }
  }

  function toggleField(key: string) {
    setAcceptedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function publish() {
    if (!displayName.trim() || !category) {
      toast({ title: "Missing tort name or category", variant: "destructive" });
      return;
    }
    setPublishing(true);
    try {
      const customFields = (proposal?.customFields ?? []).filter(f => acceptedKeys.has(f.key));
      // Only carry through knockout rules that reference an accepted field —
      // a rule pointing at a dropped field would be dead logic (and rejected
      // server-side), so we filter to keep the generated site coherent.
      const eligibilityRules = (proposal?.eligibilityRules ?? []).filter(r => acceptedKeys.has(r.field));
      const res = await apiFetchRaw("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: displayName.trim(),
          category,
          headline: headline.trim() || undefined,
          subhead: subhead.trim() || undefined,
          intro_text: introText.trim() || null,
          custom_fields: customFields,
          eligibility_rules: eligibilityRules,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || `Publish failed (${res.status})`);
      }
      toast({ title: "Site published", description: `${displayName.trim()} is now live.` });
      reset();
      onCreated();
    } catch (err) {
      toast({ title: "Publish failed", description: describeError(err), variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  }

  const canNext = useMemo(() => {
    if (step === 0) return Boolean(displayName.trim() && category);
    return true;
  }, [step, displayName, category]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-600" /> Site Maker
          </DialogTitle>
          <DialogDescription>
            Turn a tort name into a complete, live site. The canonical guardrails are attached and
            locked automatically — the AI only proposes extra tort-specific questions, which you confirm.
          </DialogDescription>
        </DialogHeader>

        {/* stepper */}
        <div className="flex items-center justify-between text-xs">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${i === step ? "bg-violet-600 text-white" : i < step ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground"}`}>
                {i < step ? "✓" : i + 1}
              </span>
              <span className={i === step ? "font-medium" : "text-muted-foreground"}>{s}</span>
              {i < WIZARD_STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        <Separator />

        {/* STEP 1 — basics */}
        {step === 0 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tort name *</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Roundup Weed Killer" />
            </div>
            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="Choose a category" /></SelectTrigger>
                <SelectContent>
                  {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Hero headline</Label>
                <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Defaults to the tort name" />
              </div>
              <div className="space-y-2">
                <Label>Sub-headline</Label>
                <Input value={subhead} onChange={(e) => setSubhead(e.target.value)} placeholder="Defaults to a qualifier line" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Intro text (optional)</Label>
              <Textarea value={introText} onChange={(e) => setIntroText(e.target.value)} placeholder="Shown above the intake form." rows={2} />
            </div>
          </div>
        )}

        {/* STEP 2 — AI scaffold */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-4 text-sm">
              The AI proposes extra tort-specific eligibility questions for <strong>{displayName || "this tort"}</strong>.
              Nothing is committed — you review and confirm each field in the next step.
            </div>
            <Button onClick={runScaffold} disabled={scaffolding} className="gap-2">
              {scaffolding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {scaffolding ? "Generating proposal…" : proposal ? "Re-generate proposal" : "Generate AI proposal"}
            </Button>

            {proposal && (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <DecisionBadge decision={proposal.decision} />
                  <span className="text-xs text-muted-foreground">confidence {(proposal.confidence * 100).toFixed(0)}%</span>
                </div>
                {proposal.reasons?.length > 0 && (
                  <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                    {proposal.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                <div className="text-xs text-muted-foreground">
                  Proposed {proposal.customFields.length} custom field{proposal.customFields.length === 1 ? "" : "s"}.
                  {proposal.statuteHint ? ` Statute hint: ${proposal.statuteHint}.` : ""}
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 3 — review fields */}
        {step === 2 && (
          <div className="space-y-3">
            {!proposal || proposal.customFields.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No AI-proposed fields. The site will still publish with the full canonical spine.
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Confirm which tort-specific questions to add. Unchecked fields are dropped.
                </p>
                {proposal.customFields.map(f => (
                  <label key={f.key} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={acceptedKeys.has(f.key)}
                      onChange={() => toggleField(f.key)}
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{f.label}</div>
                      <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">{f.type}</Badge>
                        <Badge variant="outline" className="text-[10px]">{f.section}</Badge>
                        {f.required && <Badge variant="outline" className="text-[10px]">required</Badge>}
                      </div>
                      {f.options && f.options.length > 0 && (
                        <div className="mt-1 text-[11px] text-muted-foreground">Options: {f.options.join(", ")}</div>
                      )}
                    </div>
                  </label>
                ))}
              </>
            )}
          </div>
        )}

        {/* STEP 4 — guardrails */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Lock className="h-4 w-4 text-amber-600" /> Locked canonical guardrails
            </div>
            <p className="text-sm text-muted-foreground">
              These are attached to every generated site and cannot be removed or edited. They keep the
              site TCPA-compliant and clearly positioned as not a law firm.
            </p>
            <ul className="space-y-2">
              {CANONICAL_GUARDRAILS.map(g => (
                <li key={g} className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" /> {g}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* STEP 5 — publish */}
        {step === 4 && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 text-sm">
              <div className="font-medium">{displayName || "Untitled tort"}</div>
              <div className="text-muted-foreground">Category: {category || "—"}</div>
              <div className="mt-2 text-muted-foreground">
                {acceptedKeys.size} AI field{acceptedKeys.size === 1 ? "" : "s"} accepted + full canonical spine.
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              On publish, the landing page (<code>/c/{category || "…"}/&lt;slug&gt;</code>) and intake page
              (<code>/intake/&lt;slug&gt;</code>) go live instantly. Status defaults to enabled.
            </p>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          {step < WIZARD_STEPS.length - 1 ? (
            <Button onClick={() => setStep(s => s + 1)} disabled={!canNext}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={publish} disabled={publishing} className="gap-2">
              {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              {publishing ? "Publishing…" : "Publish site"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecisionBadge({ decision }: { decision: ScaffoldProposal["decision"] }) {
  if (decision === "QUALIFIED") {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Qualified</Badge>;
  }
  if (decision === "REVIEW") {
    return <Badge className="bg-amber-500 hover:bg-amber-500">Needs review</Badge>;
  }
  return <Badge variant="outline">Rejected</Badge>;
}
