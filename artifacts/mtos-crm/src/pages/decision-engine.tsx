import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, TrendingUp, TrendingDown, Minus, RefreshCw, Settings, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetchRaw } from "@/lib/api-fetch";

interface PortfolioRow {
  tort_id: string;
  label: string;
  lead_count: number;
  total_spend_usd: number;
  qualified_count: number;
  retained_count: number;
  qualified_rate: number;
  retained_rate: number;
  classification: "convex" | "neutral" | "concave";
  action: "execute" | "modify" | "reject";
  rationale: string;
  ruin_flag_count: number;
  spend_pct: number;
}

interface PortfolioSummary {
  total_spend_usd: number;
  tort_count: number;
  convex_count: number;
  concave_count: number;
  ruin_risk_lead_count: number;
  concentration_warning: { tort_id: string; pct: number } | null;
  rows: PortfolioRow[];
}

function badgeFor(c: string) {
  if (c === "convex") return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300"><TrendingUp className="w-3 h-3 mr-1" />Convex</Badge>;
  if (c === "concave") return <Badge className="bg-rose-100 text-rose-800 border-rose-300"><TrendingDown className="w-3 h-3 mr-1" />Concave</Badge>;
  return <Badge variant="secondary"><Minus className="w-3 h-3 mr-1" />Neutral</Badge>;
}

function actionBadge(a: string) {
  if (a === "execute") return <Badge className="bg-blue-100 text-blue-800 border-blue-300">Execute</Badge>;
  if (a === "review") return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Human Review</Badge>;
  if (a === "reject") return <Badge className="bg-rose-100 text-rose-800 border-rose-300">Reject</Badge>;
  return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Modify</Badge>;
}

export default function DecisionEnginePage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery<PortfolioSummary>({
    queryKey: ["decision-engine", "portfolio"],
    queryFn: async () => {
      const res = await apiFetchRaw("/api/decision-engine/portfolio", { credentials: "include" });
      if (!res.ok) throw new Error(`portfolio failed: ${res.status}`);
      return res.json();
    },
  });

  const recomputeAll = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/decision-engine/recompute-all", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (r: { scanned: number; scored: number }) => {
      qc.invalidateQueries({ queryKey: ["decision-engine"] });
      toast({ title: "Recompute complete", description: `Scored ${r.scored} of ${r.scanned} leads.` });
    },
    onError: (e: any) => toast({ title: "Recompute failed", description: e?.message, variant: "destructive" }),
  });

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>The Decision Engine portfolio is admin-only.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="page-decision-engine">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Decision Engine</h1>
          <p className="text-muted-foreground text-sm">Portfolio convexity — asymmetric risk view across all torts</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/decision-engine/settings"><Settings className="w-4 h-4 mr-2" />Settings</Link>
          </Button>
          <Button onClick={() => recomputeAll.mutate()} disabled={recomputeAll.isPending} data-testid="button-recompute-all">
            <RefreshCw className={`w-4 h-4 mr-2 ${recomputeAll.isPending ? "animate-spin" : ""}`} />
            Recompute All
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : data ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardDescription>Total marketing spend</CardDescription></CardHeader>
              <CardContent><div className="text-2xl font-bold">${data.total_spend_usd.toLocaleString()}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Convex torts</CardDescription></CardHeader>
              <CardContent><div className="text-2xl font-bold text-emerald-600" data-testid="stat-convex-count">{data.convex_count}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Concave torts</CardDescription></CardHeader>
              <CardContent><div className="text-2xl font-bold text-rose-600" data-testid="stat-concave-count">{data.concave_count}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Leads with ruin flags</CardDescription></CardHeader>
              <CardContent><div className="text-2xl font-bold text-amber-600" data-testid="stat-ruin-count">{data.ruin_risk_lead_count}</div></CardContent>
            </Card>
          </div>

          {data.concentration_warning && (
            <Alert variant="destructive" data-testid="alert-concentration-warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Concentration risk</AlertTitle>
              <AlertDescription>
                <strong>{data.concentration_warning.tort_id}</strong> represents {data.concentration_warning.pct.toFixed(1)}% of your spend.
                Framework principle: prefer 10 small bets over 1 large bet.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Per-tort portfolio</CardTitle>
              <CardDescription>Sorted by spend. Drill into any tort to see its leads.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tort</TableHead>
                    <TableHead>Leads</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Spend %</TableHead>
                    <TableHead>Retained</TableHead>
                    <TableHead>Ruin</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Rationale</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center py-12 text-muted-foreground">No leads scored yet. Click "Recompute All" to score existing leads.</TableCell></TableRow>
                  ) : data.rows.map(r => (
                    <TableRow key={r.tort_id} data-testid={`row-tort-${r.tort_id}`}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell>{r.lead_count}</TableCell>
                      <TableCell>${r.total_spend_usd.toLocaleString()}</TableCell>
                      <TableCell>{r.spend_pct.toFixed(1)}%</TableCell>
                      <TableCell>{(r.retained_rate * 100).toFixed(1)}%</TableCell>
                      <TableCell>{r.ruin_flag_count > 0 ? <Badge variant="destructive">{r.ruin_flag_count}</Badge> : <span className="text-muted-foreground">0</span>}</TableCell>
                      <TableCell>{badgeFor(r.classification)}</TableCell>
                      <TableCell>{actionBadge(r.action)}</TableCell>
                      <TableCell className="max-w-md text-sm text-muted-foreground">{r.rationale}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" asChild>
                          <Link href={`/leads?tort_type=${encodeURIComponent(r.tort_id)}`}><ExternalLink className="w-4 h-4" /></Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
