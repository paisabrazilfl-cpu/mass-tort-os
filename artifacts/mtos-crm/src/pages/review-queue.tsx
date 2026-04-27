import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronRight, Check, X, Search, AlertTriangle } from "lucide-react";

import {
  useListReviewQueue,
  useGetReviewQueueStats,
  useResolveReviewItem,
  getListReviewQueueQueryKey,
  getGetReviewQueueStatsQueryKey,
} from "@workspace/api-client-react";
import type { ReviewQueueItem } from "@workspace/api-client-react";

import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

function getConflictBadge(conflictType: string) {
  switch (conflictType) {
    case "LOGICAL_CONFLICT":
      return <Badge variant="secondary" className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20">{conflictType}</Badge>;
    case "RULE_OVERRIDE_CONFLICT":
      return <Badge variant="secondary" className="bg-purple-500/10 text-purple-500 hover:bg-purple-500/20">{conflictType}</Badge>;
    case "DATA_INTEGRITY_CONFLICT":
      return <Badge variant="secondary" className="bg-red-500/10 text-red-500 hover:bg-red-500/20">{conflictType}</Badge>;
    case "AI_CLASSIFICATION_CONFLICT":
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20">{conflictType}</Badge>;
    case "EXECUTION_FAILURE":
      return <Badge variant="secondary" className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20">{conflictType}</Badge>;
    default:
      return <Badge variant="outline">{conflictType}</Badge>;
  }
}

function getSeverityBadge(severity: string) {
  switch (severity) {
    case "critical":
      return <Badge variant="destructive">{severity}</Badge>;
    case "high":
      return <Badge variant="secondary" className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20">{severity}</Badge>;
    case "medium":
      return <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20">{severity}</Badge>;
    case "low":
      return <Badge variant="secondary" className="bg-gray-500/10 text-gray-500 hover:bg-gray-500/20">{severity}</Badge>;
    default:
      return <Badge variant="outline">{severity}</Badge>;
  }
}

function getFailsafeText(mode: string) {
  switch (mode) {
    case "SAFE_FAIL":
      return "Auto-Reject";
    case "REVIEW_FAIL":
      return "Manual Review";
    case "HARD_BLOCK":
      return "Blocked";
    default:
      return mode;
  }
}

function ReviewQueueRow({ item }: { item: ReviewQueueItem }) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const resolveMutation = useResolveReviewItem();

  const handleResolve = (resolution: "accepted" | "rejected") => {
    // Stamp the resolution with the authenticated reviewer's identity. The
    // previous hardcoded "admin" string broke audit trails (every resolution
    // looked like it came from the same actor regardless of who clicked).
    const resolvedBy = user?.name?.trim() || user?.email || "system";
    resolveMutation.mutate(
      {
        id: item.id,
        data: { resolution, resolved_by: resolvedBy },
      },
      {
        onSuccess: () => {
          toast({
            title: `Item ${resolution}`,
            description: `Review item ${item.id} has been ${resolution}.`,
          });
          queryClient.invalidateQueries({
            queryKey: getListReviewQueueQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetReviewQueueStatsQueryKey(),
          });
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to resolve item.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <>
      <TableRow className="group cursor-pointer hover:bg-muted/50" onClick={() => setExpanded(!expanded)}>
        <TableCell>
          <Button variant="ghost" size="icon" className="h-6 w-6">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {item.id}
        </TableCell>
        <TableCell>
          <span className="font-medium">{item.entity_type}</span> / {item.entity_id}
        </TableCell>
        <TableCell>{getConflictBadge(item.conflict_type)}</TableCell>
        <TableCell>{getSeverityBadge(item.severity)}</TableCell>
        <TableCell className="text-sm">{getFailsafeText(item.failsafe_mode)}</TableCell>
        <TableCell className="max-w-[200px] truncate" title={item.summary}>
          {item.summary}
        </TableCell>
        <TableCell>
          <Badge variant={item.resolution === "pending" ? "outline" : "secondary"}>
            {item.resolution}
          </Badge>
        </TableCell>
        <TableCell className="text-right text-sm">{item.retry_count}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
          {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
        </TableCell>
        <TableCell className="text-right">
          {item.resolution === "pending" ? (
            <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-500/10"
                onClick={() => handleResolve("accepted")}
                disabled={resolveMutation.isPending}
              >
                <Check className="mr-1 h-3 w-3" /> Accept
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10"
                onClick={() => handleResolve("rejected")}
                disabled={resolveMutation.isPending}
              >
                <X className="mr-1 h-3 w-3" /> Reject
              </Button>
            </div>
          ) : null}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={11} className="bg-muted/30 p-0">
            <div className="p-6 grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium text-sm mb-1 text-muted-foreground">Full Summary</h4>
                  <p className="text-sm leading-relaxed">{item.summary}</p>
                </div>
                <div>
                  <h4 className="font-medium text-sm mb-1 text-muted-foreground">Source Module</h4>
                  <p className="text-sm font-mono bg-muted px-2 py-1 rounded inline-block">
                    {item.source_module}
                  </p>
                </div>
                {item.resolution !== "pending" && (
                  <div className="bg-background rounded-md border p-4 space-y-2 mt-4">
                    <h4 className="font-medium text-sm text-foreground">Resolution Details</h4>
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium">Resolved By:</span> {item.resolved_by || "System"}
                    </div>
                    {item.resolved_at && (
                      <div className="text-sm text-muted-foreground">
                        <span className="font-medium">Resolved At:</span> {new Date(item.resolved_at).toLocaleString()}
                      </div>
                    )}
                    {item.resolution_notes && (
                      <div className="text-sm mt-2">
                        <span className="font-medium text-muted-foreground block mb-1">Notes:</span>
                        {item.resolution_notes}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium text-sm mb-1 text-muted-foreground">Details</h4>
                  <div className="bg-muted rounded-md p-4 overflow-auto max-h-[300px]">
                    <pre className="text-xs font-mono text-foreground">
                      {JSON.stringify(item.details || {}, null, 2)}
                    </pre>
                  </div>
                </div>
                {item.resolution === "pending" && (item.severity === "critical" || item.severity === "high") && (
                  <div className="border border-red-200 bg-red-50 dark:bg-red-900/10 rounded-md p-4">
                    <h4 className="font-medium text-sm mb-2 text-red-700 dark:text-red-400 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4" /> Escalation
                    </h4>
                    <p className="text-xs text-red-600 dark:text-red-500 mb-3">
                      For suspected fraud or criminal activity, escalate to FBI tip line.
                    </p>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        apiFetchRaw(`/api/forms/escalate/fbi`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            lead_id: item.entity_id,
                            reason: `Review queue escalation: ${item.conflict_type} - ${item.summary}`,
                            fraud_indicators: item.details,
                          }),
                        })
                        .then(r => r.json())
                        .then(d => {
                          toast({
                            title: "Escalated to FBI",
                            description: "Case logged. Submit tip at tips.fbi.gov",
                          });
                          window.open("https://tips.fbi.gov/", "_blank");
                        })
                        .catch(() => {
                          toast({
                            title: "Escalation failed",
                            description: "Could not log escalation. Please try again.",
                            variant: "destructive",
                          });
                        });
                      }}
                    >
                      <AlertTriangle className="mr-1 h-3 w-3" /> Send to FBI
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function ReviewQueue() {
  const [resolution, setResolution] = useState("pending");
  const [conflictType, setConflictType] = useState("all");
  const [severity, setSeverity] = useState("all");

  const { data: stats, isLoading: statsLoading } = useGetReviewQueueStats();

  const queryParams = {
    ...(resolution !== "all" && { resolution }),
    ...(conflictType !== "all" && { conflict_type: conflictType }),
    ...(severity !== "all" && { severity }),
  };

  const { data: queueItems = [], isLoading: queueLoading } = useListReviewQueue(queryParams);

  // Card counts are read straight off the API stats payload — every field
  // here is server-scoped so the four cards finally agree on what "now" means:
  //   pending_count    = pending only
  //   critical/high    = pending only (was: all-time, screamed "act now" about resolved work)
  //   resolved_today   = today only (was: all-time sum mislabeled "Today")
  const pendingCount = stats?.total_pending ?? 0;
  const criticalCount = stats?.pending_critical ?? 0;
  const highCount = stats?.pending_high ?? 0;
  const resolvedCount = stats?.resolved_today ?? 0;

  return (
    <div className="flex flex-col gap-6 p-8 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Review Queue</h1>
          <p className="text-muted-foreground mt-2">
            Manage conflicts, execution failures, and flagged items requiring human intervention.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className={`text-2xl font-bold ${pendingCount > 0 ? "text-amber-500" : ""}`}>
                {pendingCount}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-red-500">Critical Conflicts</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-red-500">{criticalCount}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-orange-500">High Severity</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-orange-500">{highCount}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Resolved Today</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-muted-foreground">{resolvedCount}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b flex flex-wrap gap-4 items-center bg-muted/20">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Search className="h-4 w-4" />
            Filters
          </div>
          
          <Select value={resolution} onValueChange={setResolution}>
            <SelectTrigger className="w-[180px] h-9 bg-background">
              <SelectValue placeholder="Resolution" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Resolutions</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
            </SelectContent>
          </Select>

          <Select value={conflictType} onValueChange={setConflictType}>
            <SelectTrigger className="w-[240px] h-9 bg-background">
              <SelectValue placeholder="Conflict Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="LOGICAL_CONFLICT">Logical Conflict</SelectItem>
              <SelectItem value="RULE_OVERRIDE_CONFLICT">Rule Override</SelectItem>
              <SelectItem value="DATA_INTEGRITY_CONFLICT">Data Integrity</SelectItem>
              <SelectItem value="AI_CLASSIFICATION_CONFLICT">AI Classification</SelectItem>
              <SelectItem value="EXECUTION_FAILURE">Execution Failure</SelectItem>
            </SelectContent>
          </Select>

          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-[160px] h-9 bg-background">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-[40px]"></TableHead>
                <TableHead className="w-[80px]">ID</TableHead>
                <TableHead className="w-[150px]">Entity</TableHead>
                <TableHead className="w-[180px]">Conflict Type</TableHead>
                <TableHead className="w-[100px]">Severity</TableHead>
                <TableHead className="w-[140px]">Mode</TableHead>
                <TableHead className="min-w-[200px]">Summary</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead className="w-[80px] text-right">Retries</TableHead>
                <TableHead className="w-[120px] text-right">Created</TableHead>
                <TableHead className="w-[180px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queueLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-24 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-full max-w-[200px]" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-8 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-24 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : queueItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                    No review items match the current filters.
                  </TableCell>
                </TableRow>
              ) : (
                queueItems.map((item) => (
                  <ReviewQueueRow key={item.id} item={item as ReviewQueueItem} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
