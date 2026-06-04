import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  Stethoscope, Clock, CheckCircle2, AlertCircle, XCircle,
  RefreshCw, RotateCcw, ChevronLeft, ChevronRight, ExternalLink, Signal,
  Inbox, Eye, Server, Activity, Power,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { apiFetch, ApiError } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";

interface MrrRow {
  id: number;
  lead_id: number;
  lead_name: string | null;
  tort_type: string | null;
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
  hospital_npi: string | null;
  fax_result_id: number | null;
  response_fax_result_id: number | null;
  created_at: string | null;
  fax_delivery_status: string | null;
  fax_delivery_checked_at: string | null;
}

// Shape returned by GET /api/mrr/:id — a plain row from medical_records_requests
// with NO joins, so it intentionally omits lead_name / fax_delivery_status
// (those only exist on the joined list payload, MrrRow).
type MrrDetailRaw = {
  id: number;
  lead_id: number;
  hospital_name: string | null;
  hospital_npi: string | null;
  fax_number: string;
  envelope_id: number | null;
  fax_result_id: number | null;
  response_fax_result_id: number | null;
  status: string;
  sent_at: string | null;
  expected_by: string | null;
  fulfilled_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  notes: string | null;
  created_at: string | null;
  firm_id?: number | null;
  updated_at?: string | null;
};

interface MrrPage {
  results: MrrRow[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

// Global per-status counts for the pipeline summary (summed from count queries).
type StatusCounts = {
  pending: number; sent: number; failed: number; fulfilled: number; cancelled: number; total: number;
};

// Subset of GET /api/workflow-settings/:scope used by the system-status panel.
type FaxSettings = {
  fax_provider_integration_id: number | null;
  default_fax_from_number: string | null;
  auto_fax_doctor_on_signed_hipaa: boolean;
  max_send_retries: number;
};

// Subset of GET /api/workflow-settings/_options/providers (fax category only).
type ProviderOption = { id: number; name: string; provider: string; adapter_implemented: boolean };
type ProviderOptions = { fax: ProviderOption[] };

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

function FaxDeliveryBadge({ status }: { status: string | null }) {
  if (!status || status === "pending") {
    return <span className="text-xs text-amber-600 flex items-center gap-1"><Signal className="h-3 w-3" />In transit</span>;
  }
  if (status === "delivered") {
    return <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Delivered</span>;
  }
  if (status === "failed") {
    return <span className="text-xs text-red-600 flex items-center gap-1"><XCircle className="h-3 w-3" />Not delivered</span>;
  }
  return <span className="text-xs text-slate-400">Unknown</span>;
}

interface PollStats {
  pending: number;
  processing: number;
  done: number;
  dead_letter: number;
  total: number;
}

// Translate raw poll-queue counts into an at-a-glance health pill.
function workerHealth(ps: PollStats | null): { label: string; cls: string; dot: string } {
  if (!ps || ps.total === 0) {
    return { label: "Idle", cls: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-400" };
  }
  if (ps.dead_letter > 0) {
    return { label: "Degraded", cls: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" };
  }
  if (ps.processing > 0) {
    return { label: "Running", cls: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-500 animate-pulse" };
  }
  return { label: "Healthy", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" };
}

export default function MedicalRecordsPage() {
  const [data, setData] = useState<MrrPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [resending, setResending] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [pollStats, setPollStats] = useState<PollStats | null>(null);
  // System-status panel state. faxSettings: undefined = loading, null = no
  // access (the workflow-settings endpoints require elevated permissions).
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [countsError, setCountsError] = useState(false);
  const [faxSettings, setFaxSettings] = useState<FaxSettings | null | undefined>(undefined);
  // When faxSettings is null we distinguish a true auth denial (403/401 →
  // "restricted") from a transient failure (→ "couldn't load") so we never
  // claim a permission problem the operator doesn't actually have.
  const [faxSettingsRestricted, setFaxSettingsRestricted] = useState(false);
  const [faxProviders, setFaxProviders] = useState<ProviderOptions | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  // Guards against out-of-order overview responses (mount + manual refresh can
  // overlap); only the latest request is allowed to write state.
  const overviewReqRef = useRef(0);
  const [detail, setDetail] = useState<MrrRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // Monotonic token guarding against stale detail responses: if the operator
  // opens row A then quickly opens row B, A's late fetch must not apply (it
  // would merge A's raw columns onto B's seeded joined fields).
  const detailReqRef = useRef(0);
  const { toast } = useToast();

  const openDetail = useCallback(async (row: MrrRow) => {
    // Seed from the clicked list row so the drawer shows accurate data
    // immediately — the row carries joined fields (lead_name, fax delivery
    // status) that GET /api/mrr/:id does NOT return. We then merge the
    // authoritative request columns from the detail endpoint on top without
    // clobbering the joined-only fields.
    const token = ++detailReqRef.current;
    setDetail(row);
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const raw = await apiFetch<MrrDetailRaw>(`/api/mrr/${row.id}`);
      if (detailReqRef.current !== token) return; // a newer row was opened — ignore
      setDetail((prev) => ({ ...(prev ?? row), ...raw }));
    } catch {
      if (detailReqRef.current === token) {
        toast({ title: "Failed to refresh request detail", variant: "destructive" });
      }
    } finally {
      if (detailReqRef.current === token) setDetailLoading(false);
    }
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: "25" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const [d, ps] = await Promise.all([
        apiFetch<MrrPage>(`/api/mrr?${params}`),
        apiFetch<PollStats>("/api/mrr/poll-stats").catch(() => null),
      ]);
      setData(d);
      if (ps) setPollStats(ps);
    } catch {
      toast({ title: "Failed to load records", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, toast]);

  // Overview = global status counts + the "what system is running" panel.
  // Independent of the table's page/filter, so it's loaded separately and only
  // refreshed on mount or manual refresh. Elevated endpoints fail soft.
  const loadOverview = useCallback(async () => {
    const token = ++overviewReqRef.current;
    setOverviewLoading(true);
    try {
      const statuses = ["pending", "sent", "failed", "fulfilled", "cancelled"] as const;
      // allSettled so we can tell apart a real 0 from a failed fetch — a failed
      // count must never be rendered as a genuine zero.
      const [countSettled, fsWrapped, fp] = await Promise.all([
        Promise.allSettled(
          statuses.map((s) =>
            apiFetch<MrrPage>(`/api/mrr?status=${s}&page_size=1`).then((r) => r.total),
          ),
        ),
        apiFetch<FaxSettings>("/api/workflow-settings/global")
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        apiFetch<ProviderOptions>("/api/workflow-settings/_options/providers").catch(() => null),
      ]);
      if (overviewReqRef.current !== token) return; // a newer refresh superseded us
      const anyFailed = countSettled.some((r) => r.status === "rejected");
      if (anyFailed) {
        setCounts(null);
        setCountsError(true);
      } else {
        const [pending, sent, failed, fulfilled, cancelled] = countSettled.map(
          (r) => (r as PromiseFulfilledResult<number>).value,
        );
        setCounts({
          pending, sent, failed, fulfilled, cancelled,
          total: pending + sent + failed + fulfilled + cancelled,
        });
        setCountsError(false);
      }
      if (fsWrapped.ok) {
        setFaxSettings(fsWrapped.value);
        setFaxSettingsRestricted(false);
      } else {
        const status = fsWrapped.error instanceof ApiError ? fsWrapped.error.status : undefined;
        setFaxSettings(null);
        setFaxSettingsRestricted(status === 401 || status === 403);
      }
      setFaxProviders(fp);
    } finally {
      if (overviewReqRef.current === token) setOverviewLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  async function handleResend(id: number) {
    setResending(id);
    try {
      await apiFetch(`/api/mrr/${id}/resend`, { method: "POST" });
      toast({ title: "Resend queued", description: "The fax job has been re-enqueued." });
      void load();
      void loadOverview();
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
      void loadOverview();
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void load(); void loadOverview(); }}
          disabled={loading || overviewLoading}
        >
          <RotateCcw className={`h-4 w-4 mr-2 ${loading || overviewLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <WorkspaceHero
        eyebrow="Medical records workspace"
        badge="Operator-friendly flow"
        title="Work records by process, not by guesswork"
        description="The common path is simple: verify the provider, send the request, and watch for fulfillment or exceptions. Everything below supports that path without forcing staff through hidden system detail first."
        actions={[
          { label: "Provider lookup", href: "/npi-lookup", icon: Stethoscope },
          { label: "OCR inbox", href: "/ocr-inbox", icon: Inbox, variant: "outline" },
          { label: "Document review", href: "/doc-review", icon: Eye, variant: "outline" },
        ]}
        steps={[
          {
            title: "Verify provider",
            description: "Confirm the facility and fax target before the request is sent.",
            icon: Stethoscope,
            href: "/npi-lookup",
            ctaLabel: "Open lookup",
          },
          {
            title: "Send or resend",
            description: "Use the request table to push the fax out and recover failures quickly.",
            icon: RefreshCw,
          },
          {
            title: "Track delivery and intake",
            description: "Watch fulfillment, inbound faxes, and exceptions from one queue.",
            icon: Inbox,
            href: "/ocr-inbox",
            ctaLabel: "Open inbox",
          },
        ]}
      />

      {/* ── Pipeline summary — global counts per status ─────────────────── */}
      <div className="space-y-2">
        {countsError && (
          <p className="text-xs text-amber-600 flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" /> Some totals couldn't be loaded — showing “—” instead of a possibly-wrong number.
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {([
            { key: "total",     label: "Total requests", value: counts?.total,     color: "text-slate-900",  icon: Stethoscope },
            { key: "pending",   label: "Pending",        value: counts?.pending,   color: "text-slate-600",  icon: Clock },
            { key: "sent",      label: "Awaiting reply", value: counts?.sent,      color: "text-blue-600",   icon: Signal },
            { key: "fulfilled", label: "Fulfilled",      value: counts?.fulfilled, color: "text-emerald-600", icon: CheckCircle2 },
            { key: "failed",    label: "Failed",         value: counts?.failed,    color: "text-red-600",    icon: XCircle },
            { key: "cancelled", label: "Cancelled",      value: counts?.cancelled, color: "text-slate-400",  icon: AlertCircle },
          ] as const).map(({ key, label, value, color, icon: Icon }) => (
            <div key={key} className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
              <Icon className="h-4 w-4 text-slate-400" />
              {overviewLoading && !counts && !countsError
                ? <Skeleton className="h-7 w-12 mt-1.5" />
                : <p className={`text-2xl font-bold mt-1 ${countsError ? "text-slate-300" : color}`}>
                    {countsError ? "—" : (value ?? 0)}
                  </p>}
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── System status — fax provider + delivery poll worker ─────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Fax delivery system */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" /> Fax delivery system
            </CardTitle>
            <CardDescription>Which provider sends and tracks these requests.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {faxSettings === undefined ? (
              <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
            ) : faxSettings === null ? (
              <p className="text-muted-foreground text-xs">
                {faxSettingsRestricted
                  ? "Provider configuration is restricted to workflow-settings administrators."
                  : "Couldn't load the delivery-system settings right now. Try refreshing."}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Active provider</span>
                  {(() => {
                    const id = faxSettings.fax_provider_integration_id;
                    if (id == null) {
                      return (
                        <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50">
                          Environment default
                        </Badge>
                      );
                    }
                    const p = faxProviders?.fax.find((x) => x.id === id) ?? null;
                    return (
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{p?.name ?? `Integration #${id}`}</span>
                        {p && (
                          <Badge className={p.adapter_implemented
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"}>
                            {p.adapter_implemented ? "Adapter live" : "No adapter"}
                          </Badge>
                        )}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-muted-foreground">Default fax number</span>
                  <span className="font-mono text-xs">{faxSettings.default_fax_from_number || "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-muted-foreground">Auto-fax on signed HIPAA</span>
                  <Badge variant="outline" className={faxSettings.auto_fax_doctor_on_signed_hipaa
                    ? "text-emerald-700 border-emerald-200 bg-emerald-50"
                    : "text-slate-500"}>
                    <Power className="h-3 w-3 mr-1" />{faxSettings.auto_fax_doctor_on_signed_hipaa ? "On" : "Off"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-muted-foreground">Max send retries</span>
                  <span className="font-medium">{faxSettings.max_send_retries ?? "—"}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Delivery poll worker */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" /> Delivery poll worker
              {(() => {
                const h = workerHealth(pollStats);
                return (
                  <span className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${h.cls}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${h.dot}`} />{h.label}
                  </span>
                );
              })()}
            </CardTitle>
            <CardDescription>Background jobs that confirm fax delivery and inbound replies.</CardDescription>
          </CardHeader>
          <CardContent>
            {!pollStats ? (
              <p className="text-muted-foreground text-xs">Worker statistics are not available right now.</p>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: "Pending", value: pollStats.pending, color: "text-blue-600" },
                  { label: "Processing", value: pollStats.processing, color: "text-amber-600" },
                  { label: "Completed", value: pollStats.done, color: "text-emerald-600" },
                  { label: "Dead-lettered", value: pollStats.dead_letter, color: pollStats.dead_letter > 0 ? "text-red-600 font-semibold" : "text-slate-400" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="text-center">
                    <p className={`text-2xl font-bold ${color}`}>{value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
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
                    <th className="text-left py-2 pr-4 font-medium">Claimant / Tort</th>
                    <th className="text-left py-2 pr-4 font-medium">Facility</th>
                    <th className="text-left py-2 pr-4 font-medium">Fax #</th>
                    <th className="text-left py-2 pr-4 font-medium">Status</th>
                    <th className="text-left py-2 pr-4 font-medium">Fax delivery</th>
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
                          {row.tort_type && (
                            <Badge variant="outline" className="mt-1 text-[10px] font-normal text-slate-500 px-1.5 py-0">
                              {row.tort_type}
                            </Badge>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-slate-700">{row.hospital_name || "—"}</td>
                        <td className="py-3 pr-4 font-mono text-xs text-slate-600">{row.fax_number}</td>
                        <td className="py-3 pr-4">
                          <StatusBadge row={row} />
                          {row.response_fax_result_id != null && (
                            <span className="mt-1 flex items-center gap-1 text-xs text-emerald-600">
                              <Inbox className="h-3 w-3" /> Records received
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {row.status !== "fulfilled" && row.status !== "cancelled"
                            ? <FaxDeliveryBadge status={row.fax_delivery_status} />
                            : <span className="text-xs text-slate-400">—</span>}
                        </td>
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
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-slate-500"
                              onClick={() => openDetail(row)}
                            >
                              <Eye className="h-3 w-3 mr-1" /> Details
                            </Button>
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

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5" />
              Records Request {detail ? `#${detail.id}` : ""}
              {detailLoading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </SheetTitle>
            <SheetDescription>
              Full lifecycle detail for this outbound medical-records request.
            </SheetDescription>
          </SheetHeader>

          {!detail ? (
            <div className="space-y-3 mt-6">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <div className="mt-6 space-y-5 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge row={detail} />
                {detail.response_fax_result_id != null && (
                  <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 gap-1">
                    <Inbox className="h-3 w-3" /> Records received
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 border-t pt-4">
                <DetailField label="Claimant" className="col-span-3">
                  <Link href={`/leads/${detail.lead_id}`} className="text-primary hover:underline inline-flex items-center gap-1">
                    {detail.lead_name || `Lead #${detail.lead_id}`}
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </Link>
                </DetailField>
                <DetailField label="Tort / case" className="col-span-3">{detail.tort_type || "—"}</DetailField>
                <DetailField label="Facility">{detail.hospital_name || "—"}</DetailField>
                <DetailField label="Facility NPI">{detail.hospital_npi || "—"}</DetailField>
                <DetailField label="Fax number"><span className="font-mono text-xs">{detail.fax_number}</span></DetailField>
              </div>

              <div className="grid grid-cols-3 gap-2 border-t pt-4">
                <DetailField label="Sent">{detail.sent_at ? format(new Date(detail.sent_at), "MMM d, yyyy h:mm a") : "—"}</DetailField>
                <DetailField label="Expected by">{detail.expected_by ? format(new Date(detail.expected_by), "MMM d, yyyy") : "—"}</DetailField>
                <DetailField label="Fulfilled">{detail.fulfilled_at ? format(new Date(detail.fulfilled_at), "MMM d, yyyy h:mm a") : "—"}</DetailField>
                <DetailField label="Attempts">{detail.attempt_count ?? 1}</DetailField>
                <DetailField label="Last attempt">{detail.last_attempt_at ? format(new Date(detail.last_attempt_at), "MMM d, yyyy h:mm a") : "—"}</DetailField>
                <DetailField label="Created">{detail.created_at ? format(new Date(detail.created_at), "MMM d, yyyy") : "—"}</DetailField>
              </div>

              <div className="grid grid-cols-3 gap-2 border-t pt-4">
                <DetailField label="Fax delivery">
                  <FaxDeliveryBadge status={detail.fax_delivery_status} />
                </DetailField>
                <DetailField label="HIPAA envelope">{detail.envelope_id != null ? `#${detail.envelope_id}` : "Not attached"}</DetailField>
                <DetailField label="Outbound fax">{detail.fax_result_id != null ? `#${detail.fax_result_id}` : "—"}</DetailField>
              </div>

              <div className="border-t pt-4">
                <DetailField label="Received records">
                  {detail.response_fax_result_id != null ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <Inbox className="h-3.5 w-3.5" /> Inbound fax #{detail.response_fax_result_id} correlated
                    </span>
                  ) : (
                    <span className="text-slate-400">No inbound records correlated yet</span>
                  )}
                </DetailField>
                {detail.response_fax_result_id != null && (
                  <p className="text-xs text-muted-foreground mt-1">
                    View the received document from the lead's records inbox.
                  </p>
                )}
              </div>

              {detail.notes && (
                <div className="border-t pt-4">
                  <DetailField label="Notes">
                    <span className="whitespace-pre-wrap">{detail.notes}</span>
                  </DetailField>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="mt-0.5 text-slate-800">{children}</div>
    </div>
  );
}
