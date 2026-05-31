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
  Pencil,
  Eye,
  Hammer,
} from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/auth-context";
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

const WIZARD_STEPS = ["Basics", "AI Scaffold", "Review Fields", "Guardrails", "Preview", "Publish"] as const;

// Edit-prefill payload returned by GET /api/sites/:slug (locked spine stripped).
interface SiteEditDetail {
  slug: string;
  label: string;
  category: string;
  intro_text: string | null;
  headline: string;
  subhead: string;
  custom_fields: ScaffoldField[];
  eligibility_rules: ScaffoldRule[];
  active: boolean;
  web_form_enabled: boolean;
}

export default function SitesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editSite, setEditSite] = useState<SiteEditDetail | null>(null);
  const [editLoading, setEditLoading] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildingSeo, setRebuildingSeo] = useState(false);

  const isSuperAdmin = user?.role === "super_admin";

  async function openEdit(site: SiteRow) {
    setEditLoading(site.slug);
    try {
      const res = await apiFetchRaw(`/api/sites/${encodeURIComponent(site.slug)}`);
      if (!res.ok) throw new Error(`Failed to load site (${res.status})`);
      const data = (await res.json()) as { site: SiteEditDetail };
      setEditSite(data.site);
      setWizardOpen(true);
    } catch (err) {
      toast({ title: "Could not open editor", description: describeError(err), variant: "destructive" });
    } finally {
      setEditLoading(null);
    }
  }

  function viewLeads(site: SiteRow) {
    // Filter by the STABLE per-site lead source (`web_form_<slug>`), keyed by
    // the immutable slug — NOT the renameable tort label. `label` is passed only
    // for the filter banner's display text.
    navigate(
      `/leads?source=${encodeURIComponent(`web_form_${site.slug}`)}&label=${encodeURIComponent(site.label)}`,
    );
  }

  async function rebuildAll() {
    if (!confirm("Re-verify every registry site and backfill any missing web form? This never overwrites an admin-edited site.")) {
      return;
    }
    setRebuilding(true);
    try {
      const res = await apiFetchRaw("/api/sites/rebuild-all", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `Rebuild failed (${res.status})`);
      toast({
        title: "Rebuild complete",
        description: `${body.rebuilt ?? 0} backfilled · ${body.verified ?? body.total ?? 0} verified`,
      });
      void loadSites();
    } catch (err) {
      toast({ title: "Rebuild failed", description: describeError(err), variant: "destructive" });
    } finally {
      setRebuilding(false);
    }
  }

  async function rebuildAllSeo() {
    if (!confirm("Recompute the public SEO page network (hubs, supporting pages, glossary, sitemap) from the live registry? This is read-only and never changes a site.")) {
      return;
    }
    setRebuildingSeo(true);
    try {
      const res = await apiFetchRaw("/api/sites/seo/rebuild-all", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `SEO rebuild failed (${res.status})`);
      const c = body.counts ?? {};
      const dupes = (body.duplicates ?? []).length;
      toast({
        title: dupes === 0 ? "SEO pages rebuilt" : "SEO rebuilt with warnings",
        description: `${c.total ?? 0} pages · ${c.landing ?? 0} landing · ${c.supporting ?? 0} supporting · ${c.hubs ?? 0} hubs${dupes ? ` · ${dupes} duplicate paths` : ""}`,
        variant: dupes === 0 ? undefined : "destructive",
      });
    } catch (err) {
      toast({ title: "SEO rebuild failed", description: describeError(err), variant: "destructive" });
    } finally {
      setRebuildingSeo(false);
    }
  }

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
  // Category hubs are only published (200) for categories that have at least one
  // active site — empty categories 404. Mirror that here so every hub link is live.
  const liveCategories = useMemo(
    () => Array.from(new Set(sites.filter(s => s.active).map(s => s.category))).sort(),
    [sites],
  );

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
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <Button variant="outline" onClick={rebuildAll} disabled={rebuilding} className="gap-2">
              {rebuilding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />}
              {rebuilding ? "Rebuilding…" : "Rebuild all sites"}
            </Button>
          )}
          {isSuperAdmin && (
            <Button variant="outline" onClick={rebuildAllSeo} disabled={rebuildingSeo} className="gap-2">
              {rebuildingSeo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              {rebuildingSeo ? "Rebuilding…" : "Rebuild all SEO pages"}
            </Button>
          )}
          <Button onClick={() => { setEditSite(null); setWizardOpen(true); }} className="gap-2">
            <Plus className="h-4 w-4" /> New Site
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Total sites" value={sites.length} icon={<Globe className="h-4 w-4" />} />
        <StatCard label="Live" value={liveCount} icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} />
        <StatCard label="Leads captured" value={totalLeads} icon={<Users className="h-4 w-4" />} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-violet-600" /> Public SEO network
          </CardTitle>
          <CardDescription>
            The public-facing pages search engines crawl and claimants land on. Each opens the
            live page in a new tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {liveCategories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {liveCategories.map((c) => (
                <Button key={c} asChild variant="outline" size="sm" className="gap-1">
                  <a href={`/c/${encodeURIComponent(c)}`} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" /> {prettyCategory(c)} hub
                  </a>
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Glossary", href: "/glossary" },
              { label: "How It Works", href: "/how-it-works" },
              { label: "Sitemap", href: "/sitemap.xml" },
              { label: "Robots", href: "/robots.txt" },
            ].map((p) => (
              <Button key={p.href} asChild variant="outline" size="sm" className="gap-1">
                <a href={p.href} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> {p.label}
                </a>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

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
                  <TableHead>Slug</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead>Live links</TableHead>
                  <TableHead>Last edited</TableHead>
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
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{site.slug}</code>
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
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatEdited(site.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          title="Edit site"
                          disabled={editLoading === site.slug}
                          onClick={() => openEdit(site)}
                        >
                          {editLoading === site.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          title="View leads for this tort"
                          onClick={() => viewLeads(site)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {site.landing_url && (
                          <Button asChild variant="ghost" size="sm" className="gap-1" title="Open live landing page">
                            <a href={site.landing_url} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                        {site.active ? (
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" title="Soft-delete" onClick={() => softDelete(site)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" className="gap-1 text-emerald-600 hover:text-emerald-600" onClick={() => reactivate(site)}>
                            <RotateCcw className="h-4 w-4" /> Reactivate
                          </Button>
                        )}
                      </div>
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
        initialSite={editSite}
        onClose={() => { setWizardOpen(false); setEditSite(null); }}
        categories={categories}
        onCreated={() => { setWizardOpen(false); setEditSite(null); void loadSites(); }}
      />
    </div>
  );
}

// Turn a category slug ("toxic-exposure") into a readable label ("Toxic Exposure").
function prettyCategory(c: string): string {
  return c.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// Compact "last edited" label for the registry table.
function formatEdited(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
// Site Maker — 6-step wizard (create + edit).
// ─────────────────────────────────────────────────────────────────────────

function SiteMakerWizard({
  open,
  initialSite,
  onClose,
  categories,
  onCreated,
}: {
  open: boolean;
  initialSite: SiteEditDetail | null;
  onClose: () => void;
  categories: string[];
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const isEdit = Boolean(initialSite);
  const [step, setStep] = useState(0);

  // Step 1 — basics
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [category, setCategory] = useState("");
  const [headline, setHeadline] = useState("");
  const [subhead, setSubhead] = useState("");
  const [introText, setIntroText] = useState("");

  // Step 2/3 — AI scaffold (tri-state proposal, never auto-committed)
  const [scaffolding, setScaffolding] = useState(false);
  const [proposal, setProposal] = useState<ScaffoldProposal | null>(null);
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set());

  // Step 5 — route-backed draft preview (create mode). Edit mode iframes the
  // live /api/web-forms/:slug/preview route; create mode has no row yet, so it
  // POSTs the draft to /api/sites/preview and renders the authoritative HTML.
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Step 6 — publish
  const [publishing, setPublishing] = useState(false);

  // Prefill from an existing site when opening in edit mode; otherwise start
  // clean. Keyed on the dialog opening + which site is being edited.
  useEffect(() => {
    if (!open) return;
    if (initialSite) {
      setDisplayName(initialSite.label);
      setSlug(initialSite.slug);
      setSlugStatus("idle");
      setCategory(initialSite.category);
      setHeadline(initialSite.headline);
      setSubhead(initialSite.subhead);
      setIntroText(initialSite.intro_text ?? "");
      // Re-open with the existing custom fields/rules pre-checked, rendered
      // through the same Review-Fields UI as a synthetic proposal.
      setProposal({
        decision: "REVIEW",
        confidence: 1,
        reasons: ["Existing site fields — edit, add via AI, or uncheck to drop."],
        customFields: initialSite.custom_fields,
        eligibilityRules: initialSite.eligibility_rules,
      });
      setAcceptedKeys(new Set(initialSite.custom_fields.map(f => f.key)));
    } else {
      reset();
    }
    setStep(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSite]);

  function reset() {
    setStep(0);
    setDisplayName("");
    setSlug("");
    setSlugStatus("idle");
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

  // Derive a kebab slug from the display name in create mode (the slug is the
  // permanent public URL key and cannot change after publish).
  function kebab(s: string): string {
    return s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // Auto-suggest the slug from the tort name until the operator edits it.
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (isEdit || slugTouched) return;
    setSlug(kebab(displayName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, slugTouched, isEdit]);

  // Debounced collision check against GET /api/sites/:slug (200 = taken,
  // 404 = available). Skipped in edit mode (slug is locked).
  useEffect(() => {
    if (isEdit || !open) return;
    const s = slug.trim();
    if (!s) { setSlugStatus("idle"); return; }
    setSlugStatus("checking");
    const t = setTimeout(async () => {
      try {
        const res = await apiFetchRaw(`/api/sites/${encodeURIComponent(s)}`);
        setSlugStatus(res.ok ? "taken" : res.status === 404 ? "available" : "idle");
      } catch {
        setSlugStatus("idle");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [slug, isEdit, open]);

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

  // The fields/rules that will actually be published — only the accepted ones,
  // with rules pruned to those referencing an accepted field so no dead logic
  // ships (and the server doesn't reject the payload).
  const publishFields = useMemo(
    () => (proposal?.customFields ?? []).filter(f => acceptedKeys.has(f.key)),
    [proposal, acceptedKeys],
  );
  const publishRules = useMemo(
    () => (proposal?.eligibilityRules ?? []).filter(r => acceptedKeys.has(r.field)),
    [proposal, acceptedKeys],
  );

  // Create-mode preview: when the operator reaches the preview step (step 4),
  // POST the draft to the route-backed /api/sites/preview and render the
  // returned HTML. Edit mode skips this (it iframes the live preview route).
  useEffect(() => {
    if (step !== 4 || isEdit || !open) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    (async () => {
      try {
        const res = await apiFetchRaw("/api/sites/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: displayName.trim() || "Your tort",
            headline: headline.trim() || undefined,
            subhead: subhead.trim() || undefined,
            custom_fields: publishFields,
            eligibility_rules: publishRules,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `Preview failed (${res.status})`);
        if (!cancelled) setPreviewHtml(typeof body.html === "string" ? body.html : null);
      } catch (err) {
        if (!cancelled) setPreviewError(describeError(err));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isEdit, open, displayName, headline, subhead, publishFields, publishRules]);

  async function publish() {
    if (!displayName.trim() || !category) {
      toast({ title: "Missing tort name or category", variant: "destructive" });
      return;
    }
    setPublishing(true);
    try {
      const payload = {
        label: displayName.trim(),
        category,
        headline: headline.trim() || undefined,
        subhead: subhead.trim() || undefined,
        intro_text: introText.trim() || null,
        custom_fields: publishFields,
        eligibility_rules: publishRules,
      };
      // Edit re-publishes the SAME slug in place (PUT); create POSTs a new row.
      const res = isEdit
        ? await apiFetchRaw(`/api/sites/${encodeURIComponent(initialSite!.slug)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetchRaw("/api/sites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Honor the operator-chosen slug they confirmed as available, instead
            // of letting the server silently derive one from the label.
            body: JSON.stringify({ ...payload, slug: slug.trim() || undefined }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || `Publish failed (${res.status})`);
      }
      toast({
        title: isEdit ? "Site updated" : "Site published",
        description: `${displayName.trim()} is now live.`,
      });
      reset();
      onCreated();
    } catch (err) {
      toast({ title: "Publish failed", description: describeError(err), variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  }

  const canNext = useMemo(() => {
    if (step === 0) {
      if (!displayName.trim() || !category || !slug.trim()) return false;
      // In create mode the slug must be confirmed free before advancing.
      if (!isEdit && slugStatus !== "available") return false;
    }
    return true;
  }, [step, displayName, category, slug, isEdit, slugStatus]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-600" /> {isEdit ? `Edit site — ${initialSite?.label ?? ""}` : "Site Maker"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Edit this site and re-publish. The slug is locked and the canonical guardrails stay attached — your changes go live instantly on save."
              : "Turn a tort name into a complete, live site. The canonical guardrails are attached and locked automatically — the AI only proposes extra tort-specific questions, which you confirm."}
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
              <Label>Slug *</Label>
              <Input
                value={slug}
                disabled={isEdit}
                onChange={(e) => { setSlugTouched(true); setSlug(kebab(e.target.value)); }}
                placeholder="auto-generated from the tort name"
              />
              {isEdit ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> The slug is the permanent public URL key and cannot change after publish.
                </p>
              ) : slug.trim() ? (
                <p className="text-xs">
                  Public URLs: <code className="rounded bg-muted px-1 py-0.5">/intake/{slug}</code> ·{" "}
                  <code className="rounded bg-muted px-1 py-0.5">/c/{category || "…"}/{slug}</code>
                  {slugStatus === "checking" && <span className="ml-2 text-muted-foreground">checking…</span>}
                  {slugStatus === "available" && <span className="ml-2 font-medium text-emerald-600">available</span>}
                  {slugStatus === "taken" && <span className="ml-2 font-medium text-destructive">already taken</span>}
                </p>
              ) : null}
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

        {/* STEP 5 — in-CRM preview (before anything goes public) */}
        {step === 4 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isEdit
                ? "Live preview of the saved site below. Publish to apply your edits."
                : "A preview of what claimants will see. Nothing is public until you publish."}
            </p>
            {isEdit ? (
              <iframe
                title="Live site preview"
                src={`/api/web-forms/${encodeURIComponent(initialSite!.slug)}/preview`}
                className="h-[420px] w-full rounded-lg border"
              />
            ) : previewLoading ? (
              <div className="flex h-[420px] w-full items-center justify-center rounded-lg border">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : previewError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                Could not render preview: {previewError}
              </div>
            ) : previewHtml ? (
              <iframe
                title="Draft site preview"
                srcDoc={previewHtml}
                sandbox=""
                className="h-[420px] w-full rounded-lg border"
              />
            ) : (
              <div className="flex h-[420px] w-full items-center justify-center rounded-lg border text-sm text-muted-foreground">
                Preview will appear here.
              </div>
            )}
          </div>
        )}

        {/* STEP 6 — publish */}
        {step === 5 && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 text-sm">
              <div className="font-medium">{displayName || "Untitled tort"}</div>
              <div className="text-muted-foreground">Slug: <code className="rounded bg-muted px-1 py-0.5">{slug || "—"}</code></div>
              <div className="text-muted-foreground">Category: {category || "—"}</div>
              <div className="mt-2 text-muted-foreground">
                {acceptedKeys.size} {isEdit ? "custom" : "AI"} field{acceptedKeys.size === 1 ? "" : "s"} accepted + full canonical spine.
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              On {isEdit ? "save" : "publish"}, the landing page (<code>/c/{category || "…"}/{slug || "<slug>"}</code>) and intake page
              (<code>/intake/{slug || "<slug>"}</code>) {isEdit ? "update" : "go live"} instantly.
              {isEdit ? " The open/closed state is preserved." : " Status defaults to enabled."}
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
              {publishing ? "Publishing…" : isEdit ? "Save & re-publish" : "Publish site"}
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
