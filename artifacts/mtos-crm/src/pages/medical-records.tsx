import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  Stethoscope, Clock, CheckCircle2, AlertCircle, XCircle,
  RefreshCw, RotateCcw, ChevronLeft, ChevronRight, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface MrrRow {
  id: number;
  lead_id: number;
  lead_name: string | null;
  hospital_name: string | null;
  fax_number: string;
  status: string;
  sent_at: string | null;
  expected_by: string | null;
  fulfilled_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  notes: string | null;
  envelope_id: number | null;
}

interface MrrPage {
  results: MrrRow[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

function StatusBadge({ row }: { row: MrrRow }) {
  const overdue = row.status === "sent" && row.expected_by && new Date(row.expected_by) < new Date();
  if (row.status === "fulfilled") {
    return (
      <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Fulfilled
      </Badge>
    );
  }
  if (overdue) {
    return (
      <Badge className="bg-amber-50 text-amber-700 border-amber-200 gap-1">
        <AlertCircle className="h-3 w-3" /> Overdue
      </Badge>
    );
  }
  if (row.status === "sent" || row.status === "pending") {
    return (
      <Badge className="bg-blue-50 text-blue-700 border-blue-200 gap-1">
        <Clock className="h-3 w-3" /> Awaiting
      </Badge>
    );
  }
  if (row.status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  if (row.status === "cancelled") {
    return <Badge variant="outline" className="text-slate-500">Cancelled</Badge>;
  }
  return <Badge variant="outline">{row.status}</Badge>;
}

export default function MedicalRecordsPage() {
  const [data, setData] = useState<MrrPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [resending, setResending] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: "25" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const d = await apiFetch<MrrPage>(`/api/mrr?${params}`);
      setData(d);
    } catch {
      toast({ title: "Failed to load records", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, toast]);

  useEffect(() => { void load(); }, [load]);

  async function handleResend(id: number) {
    setResending(id);
    try {
      await apiFetch(`/api/mrr/${id}/resend`, { method: "POST" });
      toast({ title: "Resend queued", description: "The fax job has been re-enqueued." });
      void load();
    } catch {
      toast({ title: "Resend failed", variant: "destructive" });
    } finally {
      setResending(null);
    }
  }

  async function handleCancel(id: number) {
    setCancelling(id);
    try {
      await apiFetch(`/api/mrr/${id}/cancel`, { method: "PATCH" });
      toast({ title: "Request cancelled" });
      void load();
    } catch {
      toast({ title: "Cancel failed", variant: "destructive" });
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Medical Records Requests</h1>
          <p className="text-muted-foreground text-sm mt-1">Track all outbound records requests and their delivery status.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RotateCcw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5" />
              All Requests
              {data && <span className="text-sm font-normal text-muted-foreground ml-1">({data.total})</span>}
            </CardTitle>
            <CardDescription>Records requested from hospitals and treatment facilities</CardDescription>
          </div>
          <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="sent">Sent / Awaiting</SelectItem>
              <SelectItem value="fulfilled">Fulfilled</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : !data || data.results.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Stethoscope className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No records requests found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="text-left py-2 pr-4 font-medium">Claimant</th>
                    <th className="text-left py-2 pr-4 font-medium">Facility</th>
                    <th className="text-left py-2 pr-4 font-medium">Fax #</th>
                    <th className="text-left py-2 pr-4 font-medium">Status</th>
                    <th className="text-left py-2 pr-4 font-medium">Sent</th>
                    <th className="text-left py-2 pr-4 font-medium">Expected by</th>
                    <th className="text-left py-2 pr-4 font-medium">Attempts</th>
                    <th className="text-right py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map(row => {
                    const overdue = row.status === "sent" && row.expected_by && new Date(row.expected_by) < new Date();
                    return (
                      <tr key={row.id} className={`border-b last:border-0 hover:bg-slate-50 ${overdue ? "bg-amber-50/40" : ""}`}>
                        <td className="py-3 pr-4">
                          <Link href={`/leads/${row.lead_id}`} className="font-medium text-primary hover:underline flex items-center gap-1">
                            {row.lead_name || `Lead #${row.lead_id}`}
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </Link>
                        </td>
                        <td className="py-3 pr-4 text-slate-700">{row.hospital_name || "—"}</td>
                        <td className="py-3 pr-4 font-mono text-xs text-slate-600">{row.fax_number}</td>
                        <td className="py-3 pr-4"><StatusBadge row={row} /></td>
                        <td className="py-3 pr-4 text-slate-500 whitespace-nowrap">
                          {row.sent_at ? format(new Date(row.sent_at), "MMM d, yyyy") : "—"}
                        </td>
                        <td className={`py-3 pr-4 whitespace-nowrap ${overdue ? "text-amber-700 font-medium" : "text-slate-500"}`}>
                          {row.expected_by ? format(new Date(row.expected_by), "MMM d, yyyy") : "—"}
                        </td>
                        <td className="py-3 pr-4 text-center">
                          <span className={`font-mono text-xs px-1.5 py-0.5 rounded ${(row.attempt_count ?? 1) >= 3 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                            {row.attempt_count ?? 1}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {(row.status === "sent" || row.status === "failed") && row.envelope_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                disabled={resending === row.id}
                                onClick={() => handleResend(row.id)}
                              >
                                {resending === row.id
                                  ? <RefreshCw className="h-3 w-3 animate-spin" />
                                  : <RefreshCw className="h-3 w-3 mr-1" />}
                                {resending === row.id ? "Sending…" : "Resend"}
                              </Button>
                            )}
                            {(row.status === "sent" || row.status === "pending") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-slate-500 hover:text-destructive"
                                disabled={cancelling === row.id}
                                onClick={() => handleCancel(row.id)}
                              >
                                {cancelling === row.id ? "…" : "Cancel"}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {(data.total > data.page_size) && (
                <div className="flex items-center justify-between mt-4 pt-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    Showing {(page - 1) * data.page_size + 1}–{Math.min(page * data.page_size, data.total)} of {data.total}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-muted-foreground">Page {page}</span>
                    <Button size="sm" variant="outline" disabled={!data.has_more} onClick={() => setPage(p => p + 1)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
