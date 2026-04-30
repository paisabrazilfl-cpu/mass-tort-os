import { useLocation, useSearch } from "wouter";
import { useListQueueJobs, useRequeueDeadLetterJob, useGetQueueStats, getListQueueJobsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceStrict } from "date-fns";
import {
  ArrowLeft, RefreshCw, RotateCcw, CheckCircle, Clock, AlertCircle,
  XCircle, Briefcase, Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const STATUS_OPTIONS = ["all", "pending", "processing", "done", "dead_letter", "failed"] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "done":
      return <Badge className="bg-green-500/10 text-green-600 border-green-500/20"><CheckCircle className="w-3 h-3 mr-1" />Done</Badge>;
    case "pending":
      return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/20"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
    case "processing":
      return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20"><RefreshCw className="w-3 h-3 mr-1 animate-spin" />Processing</Badge>;
    case "dead_letter":
      return <Badge className="bg-red-500/10 text-red-600 border-red-500/20"><XCircle className="w-3 h-3 mr-1" />Dead Letter</Badge>;
    case "failed":
      return <Badge className="bg-red-500/10 text-red-600 border-red-500/20"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function JobTypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    create_case: "Create Case",
    ingest_file: "Ingest File",
    analyze_case: "Analyze Case",
  };
  return <span className="text-xs font-mono text-muted-foreground">{labels[type] ?? type}</span>;
}

export default function JobQueue() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const rawStatus = params.get("status") ?? "all";
  const activeStatus: StatusOption = STATUS_OPTIONS.includes(rawStatus as StatusOption)
    ? (rawStatus as StatusOption)
    : "all";

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const queryParams = activeStatus !== "all" ? { status: activeStatus } : undefined;
  const { data: jobs = [], isLoading, refetch } = useListQueueJobs(queryParams, {
    query: { refetchInterval: 10000 } as any,
  });

  const { data: stats } = useGetQueueStats({
    query: { refetchInterval: 10000 } as any,
  });

  const { mutate: requeue, isPending: isRequeueing } = useRequeueDeadLetterJob({
    mutation: {
      onSuccess: () => {
        toast({ title: "Job re-queued", description: "The job has been moved back to pending." });
        queryClient.invalidateQueries({ queryKey: getListQueueJobsQueryKey() });
      },
      onError: () => {
        toast({ title: "Requeue failed", variant: "destructive" });
      },
    },
  });

  function setStatus(s: StatusOption) {
    if (s === "all") {
      setLocation("/job-queue");
    } else {
      setLocation(`/job-queue?status=${s}`);
    }
  }

  function duration(job: { started_at?: string | null; completed_at?: string | null }) {
    if (!job.started_at) return "—";
    const end = job.completed_at ? new Date(job.completed_at) : new Date();
    try {
      return formatDistanceStrict(new Date(job.started_at), end);
    } catch {
      return "—";
    }
  }

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/cases")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-foreground">Job Queue</h2>
            <p className="text-muted-foreground mt-1">Background worker job history and status.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {STATUS_OPTIONS.slice(1).map((s) => {
          const count = s === "done" ? (stats?.done ?? 0)
            : s === "pending" ? (stats?.pending ?? 0)
            : s === "processing" ? (stats?.processing ?? 0)
            : s === "dead_letter" ? (stats?.dead_letter ?? 0)
            : s === "failed" ? (stats?.failed ?? 0)
            : 0;
          return (
            <Card
              key={s}
              className={`cursor-pointer transition-all hover:shadow-md ${activeStatus === s ? "ring-2 ring-primary" : ""}`}
              onClick={() => setStatus(activeStatus === s ? "all" : s)}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 px-4 pt-3">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {s.replace("_", " ")}
                </CardTitle>
                <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="text-2xl font-bold">{count}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between py-4">
          <CardTitle className="text-base">
            {activeStatus === "all" ? "All Jobs" : `${activeStatus.replace("_", " ")} Jobs`}
            <span className="ml-2 text-muted-foreground text-sm font-normal">({jobs.length})</span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
            {STATUS_OPTIONS.map((s) => (
              <Button
                key={s}
                variant={activeStatus === s ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => setStatus(s)}
              >
                {s === "all" ? "All" : s.replace("_", " ")}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[60px]">ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Case ID</TableHead>
                <TableHead className="text-center">Retries</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                    No jobs found{activeStatus !== "all" ? ` with status "${activeStatus}"` : ""}.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">#{job.id}</TableCell>
                    <TableCell><JobTypeBadge type={job.job_type} /></TableCell>
                    <TableCell><StatusBadge status={job.status} /></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {job.case_id ? (
                        <button
                          onClick={() => setLocation(`/cases/${job.case_id}`)}
                          className="hover:underline text-primary"
                        >
                          {job.case_id.substring(0, 8)}…
                        </button>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-center text-sm">
                      {job.retry_count > 0 ? (
                        <span className="text-amber-600 font-medium">{job.retry_count}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(job.created_at), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {duration(job)}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      {job.error ? (
                        <span className="text-xs text-destructive truncate block" title={job.error}>
                          {job.error.slice(0, 60)}{job.error.length > 60 ? "…" : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {job.status === "dead_letter" || job.status === "failed" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={isRequeueing}
                          onClick={() => requeue({ id: job.id })}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Requeue
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
