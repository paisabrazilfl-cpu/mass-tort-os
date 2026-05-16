/**
 * Competitive Intelligence
 *
 * Wraps Google Ads Transparency Center (via SerpAPI). Two tabs:
 *  - Lookup: paste an advertiser id (or search by name) for a one-shot
 *    view of current ad creatives.
 *  - Watchlist: persistently track competing plaintiff firms and re-pull
 *    snapshots over time as a leading indicator for new MDLs.
 *
 * Backed by:
 *   GET  /api/admin/competitive-intel/config
 *   POST /api/admin/competitive-intel/lookup
 *   GET  /api/admin/competitive-intel/watchlist
 *   POST /api/admin/competitive-intel/watchlist
 *   DELETE /api/admin/competitive-intel/watchlist/:id
 *   POST /api/admin/competitive-intel/watchlist/:id/refresh
 *
 * RBAC: every endpoint requires `competitive_intel:manage` (admin-only).
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
  Eye, AlertTriangle, RefreshCw, Search, Plus, Trash2, ExternalLink, Loader2, ImageIcon,
} from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface AdCreative {
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

interface AdvertiserSearchHit {
  advertiser_id: string;
  name?: string;
  legal_name?: string;
  verified?: boolean;
}

interface LookupResult {
  kind: "advertiser_ads" | "advertiser_search";
  advertiser?: { id?: string; name?: string; verified?: boolean; legal_name?: string };
  ad_creatives?: AdCreative[];
  advertisers?: AdvertiserSearchHit[];
}

interface WatchlistRow {
  id: number;
  firm_id: number;
  advertiser_id: string;
  label: string;
  notes: string | null;
  added_by_user_id: number;
  last_fetched_at: string | null;
  last_ad_count: number | null;
  created_at: string;
}

// Guard against javascript:/data: URLs from a third-party data source
// (SerpAPI is upstream of these cards). Returns the URL if it parses as
// http(s)://, null otherwise. Render <a> only when this returns non-null.
function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function AdCard({ ad }: { ad: AdCreative }) {
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
        <div className="text-[11px] text-muted-foreground">
          Last: {ad.last_shown ?? "—"}
        </div>
        {ad.destination_url && safeExternalUrl(ad.destination_url) && (
          <a
            href={safeExternalUrl(ad.destination_url) ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-violet-700 hover:underline inline-flex items-center gap-1"
          >
            Visit <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

export default function CompetitiveIntelPage() {
  const { toast } = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Lookup tab
  const [advertiserId, setAdvertiserId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);

  // Watchlist tab
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [watchLoading, setWatchLoading] = useState(true);
  const [addAdvId, setAddAdvId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState<number | null>(null);

  async function loadConfig() {
    const res = await apiFetchRaw("/api/admin/competitive-intel/config");
    if (res.status === 403) { setForbidden(true); return; }
    if (res.ok) {
      const j = await res.json();
      setConfigured(!!j.configured);
    }
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

  useEffect(() => { void loadConfig(); void loadWatchlist(); }, []);

  async function runLookup(mode: "id" | "search") {
    const body = mode === "id"
      ? { advertiser_id: advertiserId.trim() }
      : { query: searchQuery.trim() };
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
      setLookupResult(j);
    } finally {
      setLookupLoading(false);
    }
  }

  async function addToWatchlist() {
    if (!addAdvId.trim() || !addLabel.trim()) {
      toast({ title: "Missing fields", description: "Advertiser id and label are required.", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const res = await apiFetchRaw("/api/admin/competitive-intel/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
          ? `Saved, but initial snapshot failed: ${j.snapshot_error}`
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
      toast({ title: "Refreshed", description: `${j.ad_count ?? 0} active ads.` });
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

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl">
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          You don't have permission to use Competitive Intelligence. Ask an admin to grant
          you the <code>competitive_intel:manage</code> permission.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Eye className="h-6 w-6 text-violet-500" /> Competitive Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            See what plaintiff firms are running on Google right now. Track competitors
            over time to spot new MDLs as they launch — powered by Google's Ads
            Transparency Center via SerpAPI.
          </p>
        </div>
      </div>

      {configured === false && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-amber-900">SERPAPI_API_KEY is not set.</div>
              <div className="text-amber-800 mt-1">
                Add it in Replit Secrets to enable lookups. Get a key at{" "}
                <a className="underline" href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer">
                  serpapi.com/manage-api-key
                </a>.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="lookup" className="space-y-4">
        <TabsList>
          <TabsTrigger value="lookup" data-testid="tab-lookup">Lookup</TabsTrigger>
          <TabsTrigger value="watchlist" data-testid="tab-watchlist">
            Watchlist {rows.length > 0 && <span className="ml-1 text-xs opacity-60">({rows.length})</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="lookup" className="space-y-4">
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
                  disabled={lookupLoading || !configured || !advertiserId.trim()}
                  data-testid="button-lookup-id"
                >
                  {lookupLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
                  Look up
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Find advertiser ids at{" "}
                <a className="underline" href="https://adstransparency.google.com/" target="_blank" rel="noreferrer">
                  adstransparency.google.com
                </a> — they're in the URL when you click an advertiser.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Search by name</CardTitle></CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. Morgan & Morgan"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="input-search-query"
                />
                <Button
                  onClick={() => runLookup("search")}
                  disabled={lookupLoading || !configured || !searchQuery.trim()}
                  variant="outline"
                  data-testid="button-search"
                >
                  <Search className="h-4 w-4 mr-1" /> Search
                </Button>
              </div>
            </CardContent>
          </Card>

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
                          <Button size="sm" variant="outline" onClick={() => { setAddAdvId(a.advertiser_id); setAddLabel(a.name ?? a.advertiser_id); }}>
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
                  <span>{lookupResult.advertiser?.name ?? lookupResult.advertiser?.id ?? "Advertiser"}</span>
                  <span className="text-xs text-muted-foreground">{lookupResult.ad_creatives?.length ?? 0} ads</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(lookupResult.ad_creatives?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">No active ad creatives found.</div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {lookupResult.ad_creatives!.map((ad, i) => (
                      <AdCard key={ad.ad_creative_id ?? i} ad={ad} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="watchlist" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Plus className="h-4 w-4" /> Add advertiser</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="adv-id">Advertiser id</Label>
                  <Input
                    id="adv-id"
                    value={addAdvId}
                    onChange={(e) => setAddAdvId(e.target.value)}
                    placeholder="AR12345…"
                    className="font-mono mt-1"
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
                disabled={adding || !configured}
                className="bg-violet-600 hover:bg-violet-700"
                data-testid="button-add-watchlist"
              >
                {adding ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                Add to watchlist
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Watching ({rows.length})</CardTitle></CardHeader>
            <CardContent>
              {watchLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="text-sm text-muted-foreground">No advertisers on the watchlist yet.</div>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => (
                    <div key={r.id} className="flex items-center justify-between border rounded-md p-3" data-testid={`row-watchlist-${r.id}`}>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{r.label}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate">{r.advertiser_id}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Last fetched {relTime(r.last_fetched_at)}
                          {typeof r.last_ad_count === "number" && (
                            <> · <span className="font-medium">{r.last_ad_count}</span> active ads</>
                          )}
                        </div>
                        {r.notes && <div className="text-xs text-muted-foreground mt-1 italic">{r.notes}</div>}
                      </div>
                      <div className="flex gap-2 ml-3">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => refreshOne(r.id)}
                          disabled={refreshing === r.id || !configured}
                          data-testid={`button-refresh-${r.id}`}
                        >
                          {refreshing === r.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setAdvertiserId(r.advertiser_id); void runLookup("id"); }}
                        >
                          <Eye className="h-3 w-3" />
                        </Button>
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
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
