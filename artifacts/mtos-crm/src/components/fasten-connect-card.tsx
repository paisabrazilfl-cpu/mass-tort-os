import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetchRaw } from "@/lib/api-fetch";
import { Stethoscope, RefreshCw, ExternalLink, X, Search } from "lucide-react";
import { format } from "date-fns";

interface CatalogBrand {
  id: string;
  name: string;
  portal_name?: string;
  brand_type?: string;
}

interface FastenConnection {
  id: number;
  lead_id: number;
  backend: string;
  portal_id: string | null;
  portal_name: string | null;
  status: string;
  org_connection_id: string | null;
  last_synced_at: string | null;
  last_resource_count: number | null;
  last_error: string | null;
  updated_at: string;
}

interface FastenStatus {
  configured: boolean;
  backends: { connect: boolean; onprem: boolean };
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  active: "default",
  syncing: "secondary",
  synced: "default",
  reauth: "destructive",
  revoked: "secondary",
  error: "destructive",
};

export function FastenConnectCard({ leadId }: { leadId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<CatalogBrand[]>([]);
  const [searching, setSearching] = useState(false);

  const status = useQuery<FastenStatus>({
    queryKey: ["fasten", "status"],
    queryFn: async () => {
      const r = await apiFetchRaw("/api/fasten/status");
      if (!r.ok) throw new Error("Failed to load Fasten status");
      return r.json();
    },
  });

  const connections = useQuery<{ connections: FastenConnection[] }>({
    queryKey: ["fasten", "connections", leadId],
    queryFn: async () => {
      const r = await apiFetchRaw(`/api/fasten/connections/${leadId}`);
      if (!r.ok) throw new Error("Failed to load connections");
      return r.json();
    },
    enabled: !!status.data?.configured,
  });

  const connectMut = useMutation({
    mutationFn: async (vars: { brand_id: string; backend: "connect" | "onprem"; portal_name?: string }) => {
      const r = await apiFetchRaw("/api/fasten/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, ...vars }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ connect_url: string; backend: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Patient connect link ready",
        description: "Opening Fasten portal in a new tab. Send this link to the patient if they're not present.",
      });
      window.open(data.connect_url, "_blank", "noopener");
      qc.invalidateQueries({ queryKey: ["fasten", "connections", leadId] });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Connect failed", description: err.message });
    },
  });

  const syncMut = useMutation({
    mutationFn: async (connectionId: number) => {
      const r = await apiFetchRaw(`/api/fasten/sync/${connectionId}`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Sync queued", description: "Records will appear in the Documents tab once Fasten finishes." });
      qc.invalidateQueries({ queryKey: ["fasten", "connections", leadId] });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Sync failed", description: err.message });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: async (connectionId: number) => {
      const r = await apiFetchRaw(`/api/fasten/disconnect/${connectionId}`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Connection revoked" });
      qc.invalidateQueries({ queryKey: ["fasten", "connections", leadId] });
    },
  });

  async function searchCatalog() {
    if (!search.trim()) return;
    setSearching(true);
    try {
      const r = await apiFetchRaw(`/api/fasten/catalog?q=${encodeURIComponent(search.trim())}`);
      if (!r.ok) throw new Error("Catalog search failed");
      const data = (await r.json()) as { brands: CatalogBrand[] };
      setResults(data.brands || []);
    } catch (err) {
      toast({ variant: "destructive", title: "Search failed", description: String(err) });
    } finally {
      setSearching(false);
    }
  }

  if (status.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Stethoscope className="h-5 w-5" /> Patient Medical Records (Fasten)</CardTitle>
        </CardHeader>
        <CardContent><Skeleton className="h-20 w-full" /></CardContent>
      </Card>
    );
  }

  if (!status.data?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Stethoscope className="h-5 w-5" /> Patient Medical Records (Fasten)</CardTitle>
          <CardDescription>
            Fasten Health is not yet configured. An admin can wire it up under{" "}
            <a className="underline" href="/integrations">Settings → Integrations</a>{" "}
            (search for &quot;Fasten Connect&quot; or &quot;Fasten On-Premise&quot;).
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const conns = connections.data?.connections || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Stethoscope className="h-5 w-5" /> Patient Medical Records (Fasten)</CardTitle>
        <CardDescription>
          Generate a one-tap connect link the patient uses to authorize their healthcare provider
          (Epic MyChart, Cerner, Athena, etc.). Records flow back as FHIR and land in the Documents tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.data.backends.connect && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                placeholder="Search providers (e.g. 'epic', 'kaiser', 'cleveland clinic')…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void searchCatalog(); }}
              />
              <Button onClick={() => void searchCatalog()} disabled={searching} variant="outline">
                <Search className="h-4 w-4 mr-1" />Search
              </Button>
            </div>
            {results.length > 0 && (
              <div className="border rounded-md max-h-56 overflow-auto divide-y">
                {results.map((b) => (
                  <div key={b.id} className="flex items-center justify-between p-2 hover:bg-muted">
                    <div>
                      <div className="text-sm font-medium">{b.name}</div>
                      <div className="text-xs text-muted-foreground">{b.portal_name || b.brand_type || b.id}</div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => connectMut.mutate({ brand_id: b.id, backend: "connect", portal_name: b.name })}
                      disabled={connectMut.isPending}
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />Issue Connect Link
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status.data.backends.onprem && !status.data.backends.connect && (
          <Button
            onClick={() => connectMut.mutate({ brand_id: "", backend: "onprem", portal_name: "Fasten on-prem" })}
            disabled={connectMut.isPending}
          >
            <ExternalLink className="h-4 w-4 mr-1" />Issue On-Prem Connect Link
          </Button>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium text-muted-foreground">Connections</div>
          {connections.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : conns.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">No connections yet. Search a provider above to issue a connect link.</div>
          ) : (
            <div className="border rounded-md divide-y">
              {conns.map((c) => (
                <div key={c.id} className="p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{c.portal_name || c.portal_id || "Unnamed portal"}</span>
                      <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>{c.status}</Badge>
                      <Badge variant="outline" className="text-[10px]">{c.backend}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.last_synced_at
                        ? `Last synced ${format(new Date(c.last_synced_at), "PPp")} — ${c.last_resource_count ?? 0} resources`
                        : "Awaiting first sync"}
                    </div>
                    {c.last_error && <div className="text-xs text-destructive truncate">{c.last_error}</div>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncMut.mutate(c.id)}
                      disabled={syncMut.isPending || !c.org_connection_id || c.status === "syncing"}
                      title={!c.org_connection_id ? "Patient hasn't completed OAuth yet" : "Sync now"}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />Sync
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => disconnectMut.mutate(c.id)} disabled={disconnectMut.isPending}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
