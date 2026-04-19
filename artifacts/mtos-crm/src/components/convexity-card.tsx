import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ConvexityCardProps {
  leadId: number;
  score: string | null;
  action: string | null;
  rationale: string | null;
  ruinFlags: string[];
  downsideUsd: string | null;
  upsideUsd: string | null;
  ratio: string | null;
  confidence: string | null;
  computedAt: string | null;
}

const flagLabels: Record<string, string> = {
  sol_expired: "Statute of limitations expired",
  mdl_closed: "MDL closed (no recovery vehicle)",
  diagnosis_invalid: "Diagnosis not valid for this tort",
  exposure_missing: "Required exposure data missing",
  prior_rejection: "Lead carries prior rejection",
};

function classificationBadge(score: string | null) {
  switch (score) {
    case "convex":
      return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300"><TrendingUp className="w-3 h-3 mr-1" />Convex</Badge>;
    case "concave":
      return <Badge className="bg-rose-100 text-rose-800 border-rose-300"><TrendingDown className="w-3 h-3 mr-1" />Concave</Badge>;
    case "neutral":
      return <Badge variant="secondary"><Minus className="w-3 h-3 mr-1" />Neutral</Badge>;
    default:
      return <Badge variant="outline">Not scored</Badge>;
  }
}

function actionBadge(action: string | null) {
  switch (action) {
    case "execute":
      return <Badge className="bg-blue-100 text-blue-800 border-blue-300">Execute</Badge>;
    case "modify":
      return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Modify</Badge>;
    case "reject":
      return <Badge className="bg-rose-100 text-rose-800 border-rose-300">Reject (review)</Badge>;
    case "review":
      return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Human Review</Badge>;
    default:
      return null;
  }
}

export function ConvexityCard(props: ConvexityCardProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const recompute = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/decision-engine/leads/${props.leadId}/recompute`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ title: "Convexity recomputed" });
    },
    onError: (e: any) => toast({ title: "Recompute failed", description: e?.message, variant: "destructive" }),
  });

  const downside = props.downsideUsd ? Number(props.downsideUsd) : 0;
  const upside = props.upsideUsd ? Number(props.upsideUsd) : 0;
  const ratio = props.ratio ? Number(props.ratio) : 0;

  return (
    <Card data-testid="card-convexity">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          Decision Engine
          {classificationBadge(props.score)}
          {actionBadge(props.action)}
          {props.confidence && (
            <Badge variant="outline" className="text-xs">conf: {props.confidence}</Badge>
          )}
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => recompute.mutate()} disabled={recompute.isPending} data-testid="button-recompute-convexity">
          <RefreshCw className={`w-4 h-4 ${recompute.isPending ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.ruinFlags.length > 0 && (
          <Alert variant="destructive" data-testid="alert-ruin-flags">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <div className="font-semibold mb-1">Ruin path detected — human review required</div>
              <ul className="list-disc list-inside text-sm">
                {props.ruinFlags.map(f => <li key={f}>{flagLabels[f] || f}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {props.rationale && (
          <p className="text-sm text-muted-foreground" data-testid="text-convexity-rationale">{props.rationale}</p>
        )}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Downside</div>
            <div className="font-semibold">${downside.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Upside (E[V])</div>
            <div className="font-semibold">${upside.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Ratio</div>
            <div className="font-semibold">{ratio.toFixed(2)}x</div>
          </div>
        </div>
        {props.computedAt && (
          <div className="text-xs text-muted-foreground">
            Computed {new Date(props.computedAt).toLocaleString()}
          </div>
        )}
        {!props.score && (
          <div className="text-sm text-muted-foreground italic">
            Not scored yet — click refresh to compute.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
