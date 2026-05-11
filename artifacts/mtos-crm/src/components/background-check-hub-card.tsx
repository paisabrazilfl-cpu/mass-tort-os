import { useEffect, useMemo } from "react";
import {
  useRunLeadBackgroundCheckHub,
  useListLeadBackgroundCheckHubSnapshots,
  getListLeadBackgroundCheckHubSnapshotsQueryKey,
  type BackgroundHubResult,
  type BackgroundHubLaneResult,
  BackgroundHubResultFinalStatus,
  BackgroundHubLaneResultStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

interface Props {
  leadId: number;
}

const LANE_LABEL: Record<string, string> = {
  address: "Address Verification",
  email: "Email Validation",
  phone: "Phone Validation",
  phone_provenance: "Phone Provenance (Telnyx live carrier + burner-risk classification)",
  residency: "Residency Cross-Check (manual property-records lookup; one-click smart-link)",
  criminal_court: "Criminal / Court Records",
  incarceration: "Incarceration Status (BOP + VINELink smart-links)",
  sex_offender_nsopw: "Sex Offender Registry (NSOPW smart-link; TOS forbids automation)",
  attorney: "Attorney Conflict Check (state bar smart-links)",
  business_entity: "Business Entity Check (SEC EDGAR live + state SoS smart-links)",
  pacer_federal: "PACER (Federal Courts)",
};

// Lanes that have no live data adapter today. UI surfaces them so the
// operator gets the prompt to run the lookup manually, but they will
// always resolve to REVIEW_REQUIRED — never to a green PASS — so a buyer
// looking at the badge cluster can't misread "all green" as automated
// clearance. Source of truth: lib/bg-hub/escalation.ts → STUB_LANES.
// business_entity was demoted out of this set when the SEC EDGAR live
// adapter shipped.
const ADVISORY_MANUAL_LANES = new Set<string>([
  "residency",
  "incarceration",
  "sex_offender_nsopw",
  "attorney",
]);

function statusBadge(status: string) {
  switch (status) {
    case BackgroundHubLaneResultStatus.PASS:
      return (
        <Badge className="bg-emerald-500/10 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/15">
          <CheckCircle2 className="h-3 w-3 mr-1" />PASS
        </Badge>
      );
    case BackgroundHubLaneResultStatus.REVIEW_REQUIRED:
      return (
        <Badge className="bg-amber-500/10 text-amber-700 border border-amber-500/30 hover:bg-amber-500/15">
          <AlertTriangle className="h-3 w-3 mr-1" />REVIEW
        </Badge>
      );
    case BackgroundHubLaneResultStatus.FAIL:
      return (
        <Badge className="bg-red-500/10 text-red-700 border border-red-500/30 hover:bg-red-500/15">
          <ShieldAlert className="h-3 w-3 mr-1" />FAIL
        </Badge>
      );
    case BackgroundHubLaneResultStatus.NOT_RUN:
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <ShieldQuestion className="h-3 w-3 mr-1" />NOT RUN
        </Badge>
      );
  }
}

function finalStatusHeadline(result: BackgroundHubResult) {
  switch (result.final_status) {
    case BackgroundHubResultFinalStatus.PASS:
      return { Icon: ShieldCheck, color: "text-emerald-600", label: "PASS — All lanes clear" };
    case BackgroundHubResultFinalStatus.REVIEW_REQUIRED:
      return { Icon: AlertTriangle, color: "text-amber-600", label: "REVIEW REQUIRED" };
    case BackgroundHubResultFinalStatus.FAIL:
      return { Icon: ShieldAlert, color: "text-red-600", label: "FAIL — Disqualifying signal" };
    case BackgroundHubResultFinalStatus.NOT_RUN:
    default:
      return { Icon: ShieldQuestion, color: "text-muted-foreground", label: "NOT RUN" };
  }
}

// Sub-headline reporting just the lanes that actually run an adapter.
// Lets the operator see "automated checks cleared" without the headline
// being dragged to REVIEW by the 5 advisory stub lanes. Keep this
// strictly informational — the gating decision still uses `final_status`.
function liveLanesHeadline(result: BackgroundHubResult) {
  switch (result.final_status_live_lanes_only) {
    case BackgroundHubResultFinalStatus.PASS:
      return { color: "text-emerald-700", label: "Automated checks: PASS" };
    case BackgroundHubResultFinalStatus.REVIEW_REQUIRED:
      return { color: "text-amber-700", label: "Automated checks: REVIEW" };
    case BackgroundHubResultFinalStatus.FAIL:
      return { color: "text-red-700", label: "Automated checks: FAIL" };
    case BackgroundHubResultFinalStatus.NOT_RUN:
    default:
      return { color: "text-muted-foreground", label: "Automated checks: NOT RUN" };
  }
}

interface PacerCase {
  case_number?: string;
  title?: string;
  year?: number;
  court_id?: string;
  court_type?: string;
  date_filed?: string;
  nature_of_suit?: string;
  docket_url?: string;
}

interface PacerRaw {
  case_count?: number;
  truncated?: boolean;
  cases?: PacerCase[];
}

function PacerHitsTable({ cases, truncated }: { cases: PacerCase[]; truncated?: boolean }) {
  return (
    <div className="border rounded bg-amber-50/50 p-2 space-y-1">
      <div className="text-[11px] font-semibold text-amber-900 uppercase tracking-wider">
        PACER cases ({cases.length}{truncated ? "+" : ""}) — operator must confirm identity
      </div>
      <div className="space-y-1">
        {cases.map((c, i) => (
          <div key={i} className="text-xs border border-amber-200 rounded p-2 bg-white">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate" title={c.title ?? ""}>
                  {c.title || "(untitled case)"}
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {c.case_number ?? "—"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {[
                    c.court_id ? `Court: ${c.court_id}` : null,
                    c.court_type || null,
                    c.date_filed ? `Filed: ${c.date_filed}` : null,
                  ].filter(Boolean).join(" · ")}
                </div>
                {c.nature_of_suit && (
                  <div className="text-[11px] text-muted-foreground italic">
                    Nature: {c.nature_of_suit}
                  </div>
                )}
              </div>
              {c.docket_url && (
                <a
                  href={c.docket_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline"
                  data-testid={`pacer-docket-link-${i}`}
                >
                  Docket <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaneRow({ lane }: { lane: BackgroundHubLaneResult }) {
  const label = LANE_LABEL[lane.lane] ?? lane.lane;
  const pacerCases =
    lane.lane === "pacer_federal"
      ? ((lane.raw as PacerRaw | undefined)?.cases ?? [])
      : [];
  const pacerTruncated =
    lane.lane === "pacer_federal" ? (lane.raw as PacerRaw | undefined)?.truncated : false;
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm">{label}</div>
          <div className="text-xs text-muted-foreground">Score: {lane.score} / 100</div>
        </div>
        <div className="shrink-0">{statusBadge(lane.status)}</div>
      </div>
      {lane.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {lane.flags.map((f) => (
            <Badge key={f} variant="outline" className="text-[10px] font-mono">{f}</Badge>
          ))}
        </div>
      )}
      {lane.notes.length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {lane.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
      {lane.manual_action_urls && lane.manual_action_urls.length > 0 && (
        <div className="space-y-1.5 border-t pt-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            One-click manual lookups
          </div>
          {lane.manual_action_urls.map((m, i) => (
            <div key={i} className="flex items-start gap-2">
              <a
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs font-medium text-blue-700 hover:text-blue-900 hover:underline"
              >
                {m.label} →
              </a>
              {m.note && (
                <span className="text-[11px] text-muted-foreground italic">{m.note}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {pacerCases.length > 0 && (
        <PacerHitsTable cases={pacerCases} truncated={pacerTruncated} />
      )}
      {lane.error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
          Adapter error: {lane.error}
        </div>
      )}
      {lane.sources.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          Sources: {lane.sources.map((s) => s.name).join(" · ")}
        </div>
      )}
    </div>
  );
}

function ResultBlock({ result }: { result: BackgroundHubResult }) {
  const headline = finalStatusHeadline(result);
  const live = liveLanesHeadline(result);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border rounded-md p-3 bg-slate-50">
        <div className="flex items-center gap-2">
          <headline.Icon className={`h-5 w-5 ${headline.color}`} />
          <div>
            <div className={`font-semibold text-sm ${headline.color}`}>{headline.label}</div>
            <div className={`text-xs ${live.color}`}>
              {live.label}
              {" "}({result.summary.live_lanes_pass}/{result.summary.live_lanes_total} live lanes)
            </div>
            <div className="text-xs text-muted-foreground">
              Overall score: {result.overall_score} / 100 ·
              {" "}{result.summary.pass} pass · {result.summary.review_required} review ·
              {" "}{result.summary.fail} fail · {result.summary.not_run} not run
            </div>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground font-mono">
          {result.version}
          <br />
          {format(new Date(result.checked_at), "MMM d, yyyy HH:mm")}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {result.results.map((lane) => (
          <LaneRow key={lane.lane} lane={lane} />
        ))}
      </div>
    </div>
  );
}

export function BackgroundCheckHubCard({ leadId }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const snapshotsQueryKey = useMemo(
    () => getListLeadBackgroundCheckHubSnapshotsQueryKey(leadId),
    [leadId],
  );

  // Generated hook already gates on `enabled: !!id`, so passing leadId=0
  // safely no-ops. No need to override queryKey.
  const snapshotsQuery = useListLeadBackgroundCheckHubSnapshots(leadId);

  const runMutation = useRunLeadBackgroundCheckHub({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: snapshotsQueryKey });
        toast({ title: "Background Check Hub completed" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Background Check Hub failed",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  // Reset the mutation state when the lead changes — otherwise navigating
  // from Lead A (whose run we just executed in this component lifecycle) to
  // Lead B would surface Lead A's result as Lead B's "latest" until the next
  // fetch resolves. That's a data-integrity bug; reset on leadId change.
  const mutationReset = runMutation.reset;
  useEffect(() => {
    mutationReset();
  }, [leadId, mutationReset]);

  // Belt-and-suspenders: only treat the in-flight mutation result as
  // authoritative when it actually corresponds to THIS lead. If a stale
  // mutation payload survives (e.g., during the first render after a leadId
  // change), fall back to the snapshot query.
  const mutationDataForThisLead =
    runMutation.data && runMutation.data.lead_id === leadId
      ? runMutation.data
      : undefined;

  const latestResult: BackgroundHubResult | undefined =
    mutationDataForThisLead ?? snapshotsQuery.data?.[0]?.result;

  const previousSnapshots = snapshotsQuery.data?.slice(mutationDataForThisLead ? 0 : 1) ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Background Check Hub
          </CardTitle>
          <CardDescription>
            Unified, multi-lane verification (address, email, phone, residency, court records,
            incarceration, NSOPW, attorney conflicts, business entity, PACER federal courts).
            Stubs are explicit — no fake passes.
          </CardDescription>
        </div>
        <Button
          onClick={() => runMutation.mutate({ id: leadId })}
          disabled={runMutation.isPending || leadId <= 0}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
          data-testid="run-bg-hub"
        >
          <RefreshCw className={`h-4 w-4 ${runMutation.isPending ? "animate-spin" : ""}`} />
          {runMutation.isPending ? "Running…" : latestResult ? "Re-run Hub" : "Run Hub"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {snapshotsQuery.isLoading && !latestResult && (
          <Skeleton className="h-32 w-full" />
        )}

        {!snapshotsQuery.isLoading && !latestResult && !runMutation.isPending && (
          <div className="text-center py-8 text-muted-foreground border border-dashed rounded-md">
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No Background Check Hub run yet for this claimant.</p>
            <p className="text-xs mt-1">Click "Run Hub" to fan out across all 10 lanes.</p>
          </div>
        )}

        {latestResult && (
          <ResultBlock result={latestResult} />
        )}

        {previousSnapshots.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Previous runs ({previousSnapshots.length})
              </div>
              <div className="space-y-1">
                {previousSnapshots.map((snap) => (
                  <div
                    key={snap.id}
                    className="flex items-center justify-between text-xs border rounded p-2"
                  >
                    <div className="flex items-center gap-2">
                      {statusBadge(snap.final_status)}
                      <span className="text-muted-foreground">
                        Score {snap.overall_score} ·
                        {" "}{format(new Date(snap.created_at), "MMM d, yyyy HH:mm")}
                      </span>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {snap.version}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
