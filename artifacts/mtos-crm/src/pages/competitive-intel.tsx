/**
 * Competitive Intelligence — multi-platform ad tracker for plaintiff firms.
 *
 * Platforms:
 *   Google  — Ads Transparency Center via SerpAPI (live API)
 *   Meta    — Facebook Ad Library via Meta Graph API (live API)
 *   TikTok  — Commercial Content Library (direct link; API requires approval)
 *
 * Two tabs:
 *   Lookup   — one-shot search/lookup on any platform
 *   Watchlist — persist tracked firms, refresh snapshots over time
 *
 * The Watchlist tab ships with a "Top 10 Plaintiff Firms" quick-add panel
 * pre-populated so operators can start tracking immediately.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Eye, AlertTriangle, RefreshCw, Search, Plus, Trash2, ExternalLink,
  Loader2, ImageIcon, Zap, Facebook, Globe,
} from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

type Platform = "google" | "meta" | "tiktok";

interface PlatformConfig {
  google: boolean;
  meta: boolean;
  tiktok: boolean;
}

interface GoogleAdCreative {
  ad_creative_id?: string;
  format?: string;
  image?: string;
  video?: string;
  text?: string;
  destination_url?: string;
  first_shown?: string;
  last_shown?: string;
  days_shown?: number;
  regions?: string[];
}

interface GoogleAdvertiserHit {
  advertiser_id: string;
  name?: string;
  legal_name?: string;
  verified?: boolean;
}

interface MetaAd {
  id?: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_snapshot_url?: string;
  bylines?: string[];
  publisher_platforms?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
}

interface LookupResult {
  kind: "advertiser_ads" | "advertiser_search" | "meta_ads" | "tiktok_link";
  platform: Platform;
  // Google advertiser-ads
  advertiser?: { id?: string; name?: string; verified?: boolean; legal_name?: string };
  ad_creatives?: GoogleAdCreative[];
  // Google advertiser-search
  advertisers?: GoogleAdvertiserHit[];
  // Meta
  ads?: MetaAd[];
  // TikTok
  url?: string;
}

interface WatchlistRow {
  id: number;
  firm_id: number;
  platform: Platform;
  advertiser_id: string;
  label: string;
  notes: string | null;
  added_by_user_id: number;
  last_fetched_at: string | null;
  last_ad_count: number | null;
  created_at: string;
}

// ─── Top-10 default plaintiff firms ─────────────────────────────────────────

interface DefaultFirm {
  label: string;
  google_hint: string;
  meta_hint: string;
  notes: string;
}

const TOP_10_FIRMS: DefaultFirm[] = [
  {
    label: "Morgan & Morgan",
    google_hint: "Morgan & Morgan",
    meta_hint: "Morgan & Morgan",
    notes: "Largest personal injury firm in the US. Heavy MDL advertiser.",
  },
  {
    label: "Sokolove Law",
    google_hint: "Sokolove Law",
    meta_hint: "Sokolove Law",
    notes: "National mass tort & mesothelioma firm.",
  },
  {
    label: "Parker Waichman",
    google_hint: "Parker Waichman",
    meta_hint: "Parker Waichman",
    notes: "Large plaintiff firm — defective products & drugs.",
  },
  {
    label: "Motley Rice",
    google_hint: "Motley Rice",
    meta_hint: "Motley Rice",
    notes: "Top-tier MDL plaintiff firm — opioids, asbestos, securities.",
  },
  {
    label: "Watts Guerra",
    google_hint: "Watts Guerra",
    meta_hint: "Watts Guerra",
    notes: "Prolific mass tort aggregator — Camp Lejeune, CPAP, 3M.",
  },
  {
    label: "Weitz & Luxenberg",
    google_hint: "Weitz Luxenberg",
    meta_hint: "Weitz & Luxenberg",
    notes: "Asbestos and pharmaceutical MDL powerhouse.",
  },
  {
    label: "Simmons Hanly Conroy",
    google_hint: "Simmons Hanly Conroy",
    meta_hint: "Simmons Hanly Conroy",
    notes: "Top mesothelioma and mass tort firm.",
  },
  {
    label: "Levin Papantonio Rafferty",
    google_hint: "Levin Papantonio",
    meta_hint: "Levin Papantonio Rafferty",
    notes: "Pioneer MDL firm — opioids, Roundup, talcum powder.",
  },
  {
    label: "Lieff Cabraser Heimann & Bernstein",
    google_hint: "Lieff Cabraser",
    meta_hint: "Lieff Cabraser",
    notes: "Class action and mass tort giant — auto, pharma, securities.",
  },
  {
    label: "The Cochran Firm",
    google_hint: "The Cochran Firm",
    meta_hint: "Cochran Firm",
    notes: "National plaintiff network — injury & civil rights.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const PLATFORM_LABELS: Record<Platform, string> = {
  google: "Google",
  meta: "Meta",
  tiktok: "TikTok",
};

const PLATFORM_COLORS: Record<Platform, string> = {
  google: "bg-blue-100 text-blue-800 border-blue-200",
  meta: "bg-indigo-100 text-indigo-800 border-indigo-200",
  tiktok: "bg-pink-100 text-pink-800 border-pink-200",
};

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${PLATFORM_COLORS[platform]}`}>
      {platform === "google" && <Globe className="h-2.5 w-2.5" />}
      {platform === "meta" && <Facebook className="h-2.5 w-2.5" />}
      {platform === "tiktok" && <Zap className="h-2.5 w-2.5" />}
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

// ─── Ad card components ───────────────────────────────────────────────────────

function GoogleAdCard({ ad }: { ad: GoogleAdCreative }) {
  return (
    <div className="border rounded-md overflow-hidden bg-card">
      <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
        {ad.image ? (
          <img src={ad.image} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : ad.video ? (
          <video src={ad.video} controls className="w-full h-full" />
        ) : (
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="flex items-center gap-1 flex-wrap">
          {ad.format && <Badge variant="outline" className="text-[10px]">{ad.format}</Badge>}
          {typeof ad.days_shown === "number" && (
            <Badge variant="outline" className="text-[10px]">{ad.days_shown}d shown</Badge>
          )}
        </div>
        {ad.text && <div className="text-xs line-clamp-2">{ad.text}</div>}
        <div className="text-[11px] text-muted-foreground">Last: {ad.last_shown ?? "—"}</div>
        {ad.destination_url && (
          <a
            href={ad.destination_url}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-violet-700 hover:underline inline-flex items-center gap-1"
          >
            Visit <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

function MetaAdCard({ ad }: { ad: MetaAd }) {
  const body = ad.ad_creative_bodies?.[0] ?? ad.ad_creative_link_titles?.[0] ?? null;
  const platform = ad.publisher_platforms?.join(", ") ?? null;
  return (
    <div className="border rounded-md overflow-hidden bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <PlatformBadge platform="meta" />
        {platform && <Badge variant="outline" className="text-[10px]">{platform}</Badge>}
      </div>
      {ad.page_name && <div className="text-xs font-medium">{ad.page_name}</div>}
      {body && <div className="text-xs line-clamp-3 text-muted-foreground">{body}</div>}
      {ad.ad_delivery_start_time && (
        <div className="text-[11px] text-muted-foreground">
          Started: {new Date(ad.ad_delivery_start_time).toLocaleDateString()}
          {ad.ad_delivery_stop_time && ` · Ended: ${new Date(ad.ad_delivery_stop_time).toLocaleDateString()}`}
        </div>
      )}
      {ad.ad_snapshot_url && (
        <a
          href={ad.ad_snapshot_url}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-violet-700 hover:underline inline-flex items-center gap-1"
        >
          View on Meta <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// ─── Platform picker ──────────────────────────────────────────────────────────

function PlatformPicker({
  value,
  onChange,
  config,
}: {
  value: Platform;
  onChange: (p: Platform) => void;
  config: PlatformConfig | null;
}) {
  const platforms: { id: Platform; label: string; icon: React.ReactNode }[] = [
    { id: "google", label: "Google", icon: <Globe className="h-3.5 w-3.5" /> },
    { id: "meta", label: "Meta / Facebook", icon: <Facebook className="h-3.5 w-3.5" /> },
    { id: "tiktok", label: "TikTok", icon: <Zap className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex gap-2 flex-wrap">
      {platforms.map((p) => {
        const live = config ? config[p.id] : true;
        return (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
              value === p.id
                ? "bg-violet-600 text-white border-violet-600"
                : "bg-background text-foreground border-border hover:bg-muted"
            }`}
          >
            {p.icon}
            {p.label}
            {!live && (
              <span className="text-[10px] opacity-70 ml-0.5">(no key)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CompetitiveIntelPage() {
  const { toast } = useToast();
  const { status } = useAuth();
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Lookup tab
  const [lookupPlatform, setLookupPlatform] = useState<Platform>("google");
  const [advertiserId, setAdvertiserId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);

  // Watchlist tab
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [watchLoading, setWatchLoading] = useState(true);
  const [addPlatform, setAddPlatform] = useState<Platform>("google");
  const [addAdvId, setAddAdvId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [showDefaults, setShowDefaults] = useState(true);

  async function loadConfig() {
    const res = await apiFetchRaw("/api/admin/competitive-intel/config");
    if (res.status === 403) { setForbidden(true); return; }
    if (res.ok) setConfig(await res.json());
  }

  async function loadWatchlist() {
    setWatchLoading(true);
    try {
      const res = await apiFetchRaw("/api/admin/competitive-intel/watchlist");
      if (res.status === 403) { setForbidden(true); return; }
      if (res.ok) {
        const j = await res.json();
        setRows(j.advertisers ?? []);
      }
    } finally {
      setWatchLoading(false);
    }
  }

  useEffect(() => {
    if (status !== "authed") return;
    void loadConfig();
    void loadWatchlist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function runLookup(mode: "id" | "search", override?: { platform?: Platform; query?: string }) {
    const platform = override?.platform ?? lookupPlatform;
    const body: Record<string, string> = { platform };
    if (mode === "id") {
      body.advertiser_id = advertiserId.trim();
    } else {
      body.query = (override?.query ?? searchQuery).trim();
    }
    if (!body.advertiser_id && !body.query) return;

    setLookupLoading(true);
    setLookupResult(null);
    try {
      const res = await apiFetchRaw("/api/admin/competitive-intel/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Lookup failed", description: j?.message ?? `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      // TikTok returns a URL — open it in a new tab
      if (j.kind === "tiktok_link" && j.url) {
        window.open(j.url, "_blank", "noreferrer");
        toast({ title: "Opened TikTok Ad Library", description: "Searching their library in a new tab." });
        return;
      }
      setLookupResult(j);
    } finally {
      setLookupLoading(false);
    }
  }

  function prefillFromDefault(firm: DefaultFirm, platform: Platform) {
    const hint = platform === "meta" ? firm.meta_hint : firm.google_hint;
    setAddPlatform(platform);
    setAddAdvId(hint);
    setAddLabel(firm.label);
    setAddNotes(firm.notes);
  }

  async function addToWatchlist() {
    if (!addAdvId.trim() || !addLabel.trim()) {
      toast({ title: "Missing fields", description: "Advertiser id / search name and label are required.", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const res = await apiFetchRaw("/api/admin/competitive-intel/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: addPlatform,
          advertiser_id: addAdvId.trim(),
          label: addLabel.trim(),
          notes: addNotes.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Add failed", description: j?.message ?? `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      toast({
        title: "Added to watchlist",
        description: j.snapshot_error
          ? `Saved — initial snapshot failed: ${j.snapshot_error}`
          : addPlatform === "tiktok"
            ? "TikTok tracking saved (link-only)."
            : `Initial snapshot: ${j.ad_count ?? 0} ads.`,
      });
      setAddAdvId(""); setAddLabel(""); setAddNotes("");
      void loadWatchlist();
    } finally {
      setAdding(false);
    }
  }

  async function refreshOne(id: number) {
    setRefreshing(id);
    try {
      const res = await apiFetchRaw(`/api/admin/competitive-intel/watchlist/${id}/refresh`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Refresh failed", description: j?.message ?? `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      if (j.platform === "tiktok" && j.url) {
        window.open(j.url, "_blank", "noreferrer");
        toast({ title: "Opened TikTok Ad Library", description: "Checking their library in a new tab." });
      } else {
        toast({ title: "Refreshed", description: `${j.ad_count ?? 0} active ads.` });
      }
      void loadWatchlist();
    } finally {
      setRefreshing(null);
    }
  }

  async function removeOne(id: number) {
    if (!confirm("Remove this advertiser from your watchlist? Snapshots will be deleted.")) return;
    const res = await apiFetchRaw(`/api/admin/competitive-intel/watchlist/${id}`, { method: "DELETE" });
    if (res.ok) { toast({ title: "Removed" }); void loadWatchlist(); }
    else toast({ title: "Remove failed", variant: "destructive" });
  }

  // ── Loading / auth guards ────────────────────────────────────────────────────

  if (status === "loading" || (status === "authed" && config === null && !forbidden)) {
    return (
      <div className="p-6 max-w-3xl flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Competitive Intelligence…
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl">
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          You don't have permission to use Competitive Intelligence. Ask an admin to grant you the{" "}
          <code>competitive_intel:manage</code> permission.
        </CardContent></Card>
      </div>
    );
  }

  const anyConfigured = config ? (config.google || config.meta || config.tiktok) : false;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Eye className="h-6 w-6 text-violet-500" /> Competitive Intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Track what plaintiff firms are advertising across Google, Meta, and TikTok.
          Spot new MDLs as they launch before they flood the market.
        </p>
      </div>

      {/* ── Platform status banner ── */}
      {config && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground">Active platforms:</span>
          {(["google", "meta", "tiktok"] as Platform[]).map((p) => (
            <span
              key={p}
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${
                config[p]
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-muted text-muted-foreground border-border opacity-60"
              }`}
            >
              {p === "google" && <Globe className="h-3 w-3" />}
              {p === "meta" && <Facebook className="h-3 w-3" />}
              {p === "tiktok" && <Zap className="h-3 w-3" />}
              {PLATFORM_LABELS[p]}
              {config[p] ? " ✓" : " — no key"}
            </span>
          ))}
        </div>
      )}

      {/* ── Config warnings ── */}
      {config && !config.google && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-5 pb-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-amber-900">SERPAPI_API_KEY not set</span>
              {" — "}
              <span className="text-amber-800">
                Google lookups are disabled. Get a key at{" "}
                <a className="underline" href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer">
                  serpapi.com
                </a>.
              </span>
            </div>
          </CardContent>
        </Card>
      )}
      {config && !config.meta && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="pt-5 pb-4 flex items-start gap-3">
            <Facebook className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-blue-900">META_AD_LIBRARY_TOKEN not set</span>
              {" — "}
              <span className="text-blue-800">
                Meta lookups are disabled. Generate a User Access Token with{" "}
                <code className="bg-blue-100 px-1 rounded">ads_read</code> at{" "}
                <a className="underline" href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">
                  developers.facebook.com/tools/explorer
                </a>. Add it as <code className="bg-blue-100 px-1 rounded">META_AD_LIBRARY_TOKEN</code> in Secrets.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Main tabs ── */}
      <Tabs defaultValue="lookup" className="space-y-4">
        <TabsList>
          <TabsTrigger value="lookup" data-testid="tab-lookup">Lookup</TabsTrigger>
          <TabsTrigger value="watchlist" data-testid="tab-watchlist">
            Watchlist {rows.length > 0 && <span className="ml-1 text-xs opacity-60">({rows.length})</span>}
          </TabsTrigger>
        </TabsList>

        {/* ════════════════════════════════════════════════════
            LOOKUP TAB
        ════════════════════════════════════════════════════ */}
        <TabsContent value="lookup" className="space-y-4">
          {/* Platform picker */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Platform</CardTitle>
            </CardHeader>
            <CardContent>
              <PlatformPicker value={lookupPlatform} onChange={(p) => { setLookupPlatform(p); setLookupResult(null); }} config={config} />
            </CardContent>
          </Card>

          {lookupPlatform === "tiktok" ? (
            /* TikTok — link-only UI */
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-pink-500" /> TikTok Ad Library</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  TikTok's Research API requires special application approval. Enter a firm name
                  below and we'll open TikTok's Commercial Content Library directly in a new tab
                  pre-filtered to that firm.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g. Morgan & Morgan"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void runLookup("search"); }}
                  />
                  <Button
                    onClick={() => runLookup("search")}
                    disabled={lookupLoading || !searchQuery.trim()}
                    variant="outline"
                  >
                    <ExternalLink className="h-4 w-4 mr-1" /> Open TikTok
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Or go directly:{" "}
                  <a
                    href="https://library.tiktok.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-pink-600"
                  >
                    library.tiktok.com
                  </a>
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Google / Meta — by id (Google) or name */}
              {lookupPlatform === "google" && (
                <Card>
                  <CardHeader><CardTitle className="text-base">By advertiser id</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Input
                        placeholder="AR12345678901234567"
                        value={advertiserId}
                        onChange={(e) => setAdvertiserId(e.target.value)}
                        data-testid="input-advertiser-id"
                        className="font-mono"
                      />
                      <Button
                        onClick={() => runLookup("id")}
                        disabled={lookupLoading || !config?.google || !advertiserId.trim()}
                        data-testid="button-lookup-id"
                      >
                        {lookupLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
                        Look up
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Find ids at{" "}
                      <a className="underline" href="https://adstransparency.google.com/" target="_blank" rel="noreferrer">
                        adstransparency.google.com
                      </a>{" "}
                      — they appear in the URL when you click an advertiser.
                    </p>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {lookupPlatform === "meta" ? "Search by firm name or Facebook Page ID" : "Search by name"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder={lookupPlatform === "meta" ? "e.g. Morgan & Morgan or 123456789" : "e.g. Morgan & Morgan"}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      data-testid="input-search-query"
                      onKeyDown={(e) => { if (e.key === "Enter") void runLookup("search"); }}
                    />
                    <Button
                      onClick={() => runLookup("search")}
                      disabled={lookupLoading || (lookupPlatform === "google" && !config?.google) || (lookupPlatform === "meta" && !config?.meta) || !searchQuery.trim()}
                      variant="outline"
                      data-testid="button-search"
                    >
                      {lookupLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
                      Search
                    </Button>
                  </div>
                  {lookupPlatform === "meta" && (
                    <p className="text-xs text-muted-foreground">
                      Enter a numeric Page ID (e.g. <code>123456789012345</code>) for exact results, or
                      a firm name to search by keyword. Find page ids at{" "}
                      <a className="underline" href="https://www.facebook.com/ads/library/" target="_blank" rel="noreferrer">
                        facebook.com/ads/library
                      </a>.
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* ── Lookup results ── */}
          {lookupResult?.kind === "advertiser_search" && (
            <Card>
              <CardHeader><CardTitle className="text-base">Search results</CardTitle></CardHeader>
              <CardContent>
                {(lookupResult.advertisers?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">No advertisers found.</div>
                ) : (
                  <div className="space-y-2">
                    {lookupResult.advertisers!.map((a) => (
                      <div key={a.advertiser_id} className="flex items-center justify-between border rounded-md p-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{a.name ?? a.legal_name ?? a.advertiser_id}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate">{a.advertiser_id}</div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => { setAdvertiserId(a.advertiser_id); void runLookup("id"); }}>
                            View ads
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setAddAdvId(a.advertiser_id); setAddLabel(a.name ?? a.advertiser_id); setAddPlatform("google"); }}>
                            <Plus className="h-3 w-3 mr-1" /> Add
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {lookupResult?.kind === "advertiser_ads" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <PlatformBadge platform="google" />
                    {lookupResult.advertiser?.name ?? lookupResult.advertiser?.id ?? "Advertiser"}
                  </span>
                  <span className="text-xs text-muted-foreground">{lookupResult.ad_creatives?.length ?? 0} ads</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(lookupResult.ad_creatives?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">No active ad creatives found.</div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {lookupResult.ad_creatives!.map((ad, i) => (
                      <GoogleAdCard key={ad.ad_creative_id ?? i} ad={ad} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {lookupResult?.kind === "meta_ads" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <PlatformBadge platform="meta" />
                    Meta Ad Library results
                  </span>
                  <span className="text-xs text-muted-foreground">{lookupResult.ads?.length ?? 0} ads</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(lookupResult.ads?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">No active ads found on Meta.</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {lookupResult.ads!.map((ad, i) => (
                      <MetaAdCard key={ad.id ?? i} ad={ad} />
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-3">
                  See full library at{" "}
                  <a className="underline" href="https://www.facebook.com/ads/library/" target="_blank" rel="noreferrer">
                    facebook.com/ads/library
                  </a>
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ════════════════════════════════════════════════════
            WATCHLIST TAB
        ════════════════════════════════════════════════════ */}
        <TabsContent value="watchlist" className="space-y-4">

          {/* Top-10 default firms panel */}
          {showDefaults && (
            <Card className="border-violet-200 bg-violet-50/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-violet-500" />
                    Top 10 Plaintiff Firms — Quick Add
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs text-muted-foreground h-7"
                    onClick={() => setShowDefaults(false)}
                  >
                    Dismiss
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  Click a firm to pre-fill the Add form below, then choose your platform and save.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {TOP_10_FIRMS.map((firm) => (
                    <div
                      key={firm.label}
                      className="flex items-center justify-between bg-background border rounded-md px-3 py-2 gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{firm.label}</div>
                        <div className="text-xs text-muted-foreground truncate">{firm.notes}</div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 border-blue-200 text-blue-700 hover:bg-blue-50"
                          title="Add to Google watchlist"
                          onClick={() => prefillFromDefault(firm, "google")}
                        >
                          <Globe className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                          title="Add to Meta watchlist"
                          onClick={() => prefillFromDefault(firm, "meta")}
                        >
                          <Facebook className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 border-pink-200 text-pink-700 hover:bg-pink-50"
                          title="Add to TikTok watchlist"
                          onClick={() => prefillFromDefault(firm, "tiktok")}
                        >
                          <Zap className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Add form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="h-4 w-4" /> Add to watchlist
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Platform picker */}
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Platform</Label>
                <PlatformPicker value={addPlatform} onChange={setAddPlatform} config={config} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="adv-id">
                    {addPlatform === "google"
                      ? "Advertiser id"
                      : addPlatform === "meta"
                        ? "Firm name or Facebook Page ID"
                        : "Firm name (for TikTok search)"}
                  </Label>
                  <Input
                    id="adv-id"
                    value={addAdvId}
                    onChange={(e) => setAddAdvId(e.target.value)}
                    placeholder={
                      addPlatform === "google"
                        ? "AR12345…"
                        : addPlatform === "meta"
                          ? "Morgan & Morgan or 123456789"
                          : "Morgan & Morgan"
                    }
                    className={addPlatform === "google" ? "font-mono mt-1" : "mt-1"}
                    data-testid="input-add-adv-id"
                  />
                </div>
                <div>
                  <Label htmlFor="adv-label">Label</Label>
                  <Input
                    id="adv-label"
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder="Morgan & Morgan"
                    className="mt-1"
                    data-testid="input-add-label"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="adv-notes">Notes (optional)</Label>
                <Textarea
                  id="adv-notes"
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  placeholder="Why are we tracking this firm?"
                  className="mt-1"
                  rows={2}
                />
              </div>
              <Button
                onClick={addToWatchlist}
                disabled={adding || (addPlatform === "google" && !config?.google) || (addPlatform === "meta" && !config?.meta)}
                className="bg-violet-600 hover:bg-violet-700"
                data-testid="button-add-watchlist"
              >
                {adding ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                Add to watchlist
              </Button>
              {!showDefaults && (
                <Button size="sm" variant="ghost" className="ml-2 text-xs" onClick={() => setShowDefaults(true)}>
                  Show top 10 defaults
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Watchlist rows */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Watching ({rows.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {watchLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="text-sm text-muted-foreground">No advertisers on the watchlist yet. Use the Top 10 panel above to get started quickly.</div>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => {
                    const platform = (r.platform ?? "google") as Platform;
                    return (
                      <div key={r.id} className="flex items-center justify-between border rounded-md p-3" data-testid={`row-watchlist-${r.id}`}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate">{r.label}</span>
                            <PlatformBadge platform={platform} />
                          </div>
                          <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">{r.advertiser_id}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {platform === "tiktok" ? (
                              <span className="italic">Link-only — refresh opens TikTok library</span>
                            ) : (
                              <>
                                Last fetched {relTime(r.last_fetched_at)}
                                {typeof r.last_ad_count === "number" && (
                                  <> · <span className="font-medium">{r.last_ad_count}</span> active ads</>
                                )}
                              </>
                            )}
                          </div>
                          {r.notes && <div className="text-xs text-muted-foreground mt-1 italic">{r.notes}</div>}
                        </div>
                        <div className="flex gap-2 ml-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => refreshOne(r.id)}
                            disabled={refreshing === r.id || (platform === "google" && !config?.google) || (platform === "meta" && !config?.meta)}
                            title="Refresh"
                            data-testid={`button-refresh-${r.id}`}
                          >
                            {refreshing === r.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                          </Button>
                          {platform !== "tiktok" && (
                            <Button
                              size="sm"
                              variant="outline"
                              title="View in Lookup tab"
                              onClick={() => {
                                setLookupPlatform(platform);
                                if (platform === "google") {
                                  setAdvertiserId(r.advertiser_id);
                                  void runLookup("id", { platform: "google" });
                                } else {
                                  setSearchQuery(r.advertiser_id);
                                  void runLookup("search", { platform, query: r.advertiser_id });
                                }
                              }}
                            >
                              <Eye className="h-3 w-3" />
                            </Button>
                          )}
                          {platform === "tiktok" && (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Open TikTok library"
                              onClick={() => {
                                const url = `https://library.tiktok.com/?q=${encodeURIComponent(r.advertiser_id)}&type=0&status=0&region=US&timeRange=0`;
                                window.open(url, "_blank", "noreferrer");
                              }}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeOne(r.id)}
                            data-testid={`button-remove-${r.id}`}
                          >
                            <Trash2 className="h-3 w-3 text-rose-600" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Other platforms — external links */}
          <Card className="border-dashed">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-muted-foreground">Other ad transparency libraries</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "LinkedIn Ad Library", url: "https://www.linkedin.com/ad-library/search" },
                  { label: "X (Twitter) Ad Transparency", url: "https://ads.twitter.com/transparency" },
                  { label: "YouTube Ad Transparency", url: "https://adstransparency.google.com/?region=US&platform=VIDEO" },
                  { label: "Snapchat Ad Library", url: "https://www.snap.com/en-US/ad-transparency" },
                ].map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs border rounded px-2 py-1 hover:bg-muted transition-colors"
                  >
                    {l.label} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
