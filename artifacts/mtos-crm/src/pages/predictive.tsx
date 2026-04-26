import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { TrendingUp, TrendingDown, Search, RefreshCw, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface PredictiveScore {
  lead_id: number;
  conversion_probability: number;
  risk_score: number;
  quality_tier: string;
  factors: { name: string; impact: number; description: string }[];
}

interface TortPrediction {
  tort_type: string;
  avg_conversion: number;
  avg_risk: number;
  count: number;
}

interface ModelStats {
  total_training_samples: number;
  feature_weights: Record<string, number>;
  model_accuracy: number;
  last_trained: string;
}

const tierColors: Record<string, string> = {
  platinum: "bg-purple-100 text-purple-800 border-purple-300",
  gold: "bg-yellow-100 text-yellow-800 border-yellow-300",
  silver: "bg-gray-100 text-gray-700 border-gray-300",
  bronze: "bg-orange-100 text-orange-800 border-orange-300",
  unqualified: "bg-red-100 text-red-800 border-red-300",
};

export default function Predictive() {
  const { toast } = useToast();
  const [batchScores, setBatchScores] = useState<PredictiveScore[]>([]);
  const [tortPredictions, setTortPredictions] = useState<TortPrediction[]>([]);
  const [modelStats, setModelStats] = useState<ModelStats | null>(null);
  const [singleScore, setSingleScore] = useState<PredictiveScore | null>(null);
  const [searchId, setSearchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [batchRes, tortRes, modelRes] = await Promise.all([
        apiFetchRaw("/api/analytics/predictive/batch?limit=25"),
        apiFetchRaw("/api/analytics/predictive/by-tort"),
        apiFetchRaw("/api/analytics/predictive/model"),
      ]);
      setBatchScores(await batchRes.json());
      setTortPredictions(await tortRes.json());
      setModelStats(await modelRes.json());
    } catch {
      toast({ title: "Failed to load predictions", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const searchLead = async () => {
    if (!searchId) return;
    setSearching(true);
    try {
      const res = await apiFetchRaw(`/api/analytics/predictive/lead/${searchId}`);
      if (!res.ok) throw new Error("Not found");
      setSingleScore(await res.json());
    } catch {
      toast({ title: "Lead not found", variant: "destructive" });
    } finally {
      setSearching(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Praxis AI Analytics</h1>
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20" /></CardContent></Card>)}
        </div>
      </div>
    );
  }

  const avgConversion = batchScores.length > 0 ? Math.round(batchScores.reduce((s, b) => s + b.conversion_probability, 0) / batchScores.length) : 0;
  const avgRisk = batchScores.length > 0 ? Math.round(batchScores.reduce((s, b) => s + b.risk_score, 0) / batchScores.length) : 0;
  const tierCounts: Record<string, number> = {};
  batchScores.forEach(b => { tierCounts[b.quality_tier] = (tierCounts[b.quality_tier] || 0) + 1; });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Praxis AI Analytics</h1>
          <p className="text-muted-foreground">Predictive scoring and quality analysis across your lead pipeline.</p>
        </div>
        <Button variant="outline" onClick={fetchData}><RefreshCw className="h-4 w-4 mr-2" />Refresh</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Avg Conversion Score</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-600" />
              <span className="text-3xl font-bold">{avgConversion}%</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Avg Risk Score</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-red-600" />
              <span className="text-3xl font-bold">{avgRisk}%</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Model Accuracy</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{modelStats ? Math.round(modelStats.model_accuracy * 100) : 0}%</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Training Samples</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{modelStats?.total_training_samples || 0}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Score a Lead</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 max-w-md">
            <Input placeholder="Lead ID" value={searchId} onChange={(e) => setSearchId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchLead()} />
            <Button onClick={searchLead} disabled={searching}><Search className="h-4 w-4 mr-2" />{searching ? "..." : "Score"}</Button>
          </div>
          {singleScore && (
            <div className="mt-4 p-4 border rounded-lg">
              <div className="flex items-center gap-4 mb-3">
                <Badge className={tierColors[singleScore.quality_tier] || ""}>{singleScore.quality_tier.toUpperCase()}</Badge>
                <span className="text-sm">Lead #{singleScore.lead_id}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 mb-3">
                <div className="flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4 text-green-600" />
                  <span className="text-sm">Conversion: <strong>{singleScore.conversion_probability}%</strong></span>
                </div>
                <div className="flex items-center gap-2">
                  <ArrowDownRight className="h-4 w-4 text-red-600" />
                  <span className="text-sm">Risk: <strong>{singleScore.risk_score}%</strong></span>
                </div>
              </div>
              <div className="space-y-1">
                {singleScore.factors.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className={f.impact > 0 ? "text-green-600" : f.impact < 0 ? "text-red-600" : "text-gray-500"}>
                      {f.impact > 0 ? "+" : f.impact < 0 ? "-" : "~"}
                    </span>
                    <span>{f.name}: {f.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quality Distribution</CardTitle>
            <CardDescription>Lead quality tiers across recent leads</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([tier, count]) => (
              <div key={tier} className="flex items-center justify-between">
                <Badge className={tierColors[tier] || ""}>{tier.toUpperCase()}</Badge>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-gray-100 rounded-full h-2">
                    <div className="h-2 rounded-full bg-primary" style={{ width: `${(count / batchScores.length) * 100}%` }} />
                  </div>
                  <span className="text-sm font-bold w-8 text-right">{count}</span>
                </div>
              </div>
            ))}
            {Object.keys(tierCounts).length === 0 && <div className="text-sm text-muted-foreground">No data yet</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By Tort Type</CardTitle>
            <CardDescription>Average conversion and risk by tort</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tort</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Conv %</TableHead>
                  <TableHead>Risk %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tortPredictions.sort((a, b) => b.avg_conversion - a.avg_conversion).map((t) => (
                  <TableRow key={t.tort_type}>
                    <TableCell className="font-medium text-sm">{t.tort_type}</TableCell>
                    <TableCell>{t.count}</TableCell>
                    <TableCell className="text-green-600 font-bold">{t.avg_conversion}%</TableCell>
                    <TableCell className="text-red-600 font-bold">{t.avg_risk}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Lead Predictions</CardTitle>
          <CardDescription>Predictive scores for the most recent {batchScores.length} leads</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead ID</TableHead>
                <TableHead>Quality Tier</TableHead>
                <TableHead>Conversion %</TableHead>
                <TableHead>Risk %</TableHead>
                <TableHead>Top Factor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batchScores.map((s) => (
                <TableRow key={s.lead_id}>
                  <TableCell className="font-mono">#{s.lead_id}</TableCell>
                  <TableCell><Badge className={tierColors[s.quality_tier] || ""}>{s.quality_tier.toUpperCase()}</Badge></TableCell>
                  <TableCell className={s.conversion_probability >= 50 ? "text-green-600 font-bold" : ""}>{s.conversion_probability}%</TableCell>
                  <TableCell className={s.risk_score >= 50 ? "text-red-600 font-bold" : ""}>{s.risk_score}%</TableCell>
                  <TableCell className="text-sm">{s.factors[0]?.name || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
