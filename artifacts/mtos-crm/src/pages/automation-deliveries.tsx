import { useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useListWebhookDeliveries,
  useResendWebhookDelivery,
  getListWebhookDeliveriesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  RefreshCw, RotateCcw, CheckCircle, AlertCircle, Filter, Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

type StatusFilter = "all" | "success" | "failure";
const STATUS_FILTERS: StatusFilter[] = ["all", "success", "failure"];

type EventFilter = "all" | "lead.created" | "lead.updated" | "ocr.completed" | "case.stage_changed";
const EVENT_FILTERS: EventFilter[] = ["all", "lead.created", "lead.updated", "ocr.completed", "case.stage_changed"];

interface IntegrationOption {
  id: number;
  label: string;
}

function isSuccess(statusCode: number | null | undefined): boolean {
  return typeof statusCode === "number" && statusCode >= 200 && statusCode < 300;
}

function DeliveryStatusBadge({ statusCode }: { statusCode: number | null | undefined }) {
  if (statusCode == null || statusCode === 0) {
    return (
      <Badge className="bg-red-500/10 text-red-600 border-red-500/20">
        <AlertCircle className="w-3 h-3 mr-1" />Timeout
      </Badge>
    );
  }
  if (isSuccess(statusCode)) {
    return (
      <Badge className="bg-green-500/10 text-green-600 border-green-500/20">
        <CheckCircle className="w-3 h-3 mr-1" />{statusCode}
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/10 text-red-600 border-red-500/20">
      <AlertCircle className="w-3 h-3 mr-1" />{statusCode}
    </Badge>
  );
}

function EventBadge({ event }: { event: string }) {
  const colors: Record<string, string> = {
    "lead.created": "bg-blue-500/10 text-blue-600 border-blue-500/20",
    "lead.updated": "bg-indigo-500/10 text-indigo-600 border-indigo-500/20",
    "ocr.completed": "bg-purple-500/10 text-purple-600 border-purple-500/20",
    "case.stage_changed": "bg-amber-500/10 text-amber-600 border-amber-500/20",
  };
  return (
    <Badge className={colors[event] ?? "bg-muted/50 text-muted-foreground"}>
      {event}
    </Badge>
  );
}

export default function AutomationDeliveries() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const rawStatus = params.get("status") as StatusFilter ?? "all";
  const activeStatus: StatusFilter = STATUS_FILTERS.includes(rawStatus) ? rawStatus : "all";

  const rawEvent = params.get("event") as EventFilter ?? "all";
  const activeEvent: EventFilter = EVENT_FILTERS.includes(rawEvent) ? rawEvent : "all";

  const rawIntegration = params.get("integration_id");
  const activeIntegrationId: number | undefined =
    rawIntegration && /^\d+$/.test(rawIntegration) ? Number(rawIntegration) : undefined;

  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const seenIntegrationsRef = useRef<Map<number, string>>(new Map());

  function buildQuery(
    s?: StatusFilter,
    e?: EventFilter,
    integId?: number | null,
    p?: number,
  ) {
    const ps = new URLSearchParams();
    const status = s ?? activeStatus;
    const event = e ?? activeEvent;
    const integ = integId === undefined ? activeIntegrationId : (integId ?? undefined);
    const pg = p ?? page;
    if (status !== "all") ps.set("status", status);
    if (event !== "all") ps.set("event", event);
    if (integ != null) ps.set("integration_id", String(integ));
    if (pg > 1) ps.set("page", String(pg));
    const qs = ps.toString();
    setLocation(qs ? `/automation-deliveries?${qs}` : "/automation-deliveries");
  }

  const queryArgs: Parameters<typeof useListWebhookDeliveries>[0] = {
    ...(activeStatus !== "all" ? { status: activeStatus } : {}),
    ...(activeEvent !== "all" ? { event: activeEvent } : {}),
    ...(activeIntegrationId != null ? { integration_id: activeIntegrationId } : {}),
    page,
    page_size: 50,
  };

  const { data, isLoading, refetch } = useListWebhookDeliveries(queryArgs, {
    query: {
      queryKey: getListWebhookDeliveriesQueryKey(queryArgs),
      refetchInterval: 30000,
    },
  });

  const rows = data?.data?.rows ?? [];
  const total = data?.data?.total ?? 0;
  const pageSize = data?.data?.page_size ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    rows.forEach((row) => {
      if (!seenIntegrationsRef.current.has(row.integration_id)) {
        const label = row.integration_name
          ? `${row.integration_name}${row.integration_provider ? ` (${row.integration_provider})` : ""}`
          : `Integration #${row.integration_id}`;
        seenIntegrationsRef.current.set(row.integration_id, label);
      }
    });
  }, [rows]);

  const integrationOptions: IntegrationOption[] = Array.from(
    seenIntegrationsRef.current.entries(),
  ).map(([id, label]) => ({ id, label }));

  const hasFilters = activeStatus !== "all" || activeEvent !== "all" || activeIntegrationId != null;

  const { mutate: resend, isPending: isResending } = useResendWebhookDelivery({
    mutation: {
      onSuccess: (result) => {
        const ok = result.data?.success;
        toast({
          title: ok ? "Resend succeeded" : "Resend failed",
          description: ok
            ? `Delivery ${result.data?.delivery_id?.slice(0, 8)}… → HTTP ${result.data?.response_status}`
            : `HTTP ${result.data?.response_status}: ${result.data?.error ?? "unknown error"}`,
          variant: ok ? "default" : "destructive",
        });
        queryClient.invalidateQueries({ queryKey: getListWebhookDeliveriesQueryKey() });
      },
      onError: () => {
        toast({ title: "Resend request failed", variant: "destructive" });
      },
    },
  });

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Webhook className="h-7 w-7 text-primary" />
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              Webhook Delivery Log
            </h2>
            <p className="text-muted-foreground mt-1">
              Every outbound event attempt to automation integrations (n8n, Zapier, Make).
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 items-start">
        <Card className="flex-1 min-w-[200px]">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Filter by Status
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 flex gap-1 flex-wrap">
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s}
                variant={activeStatus === s ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-2 capitalize"
                onClick={() => buildQuery(s, activeEvent, undefined, 1)}
              >
                {s}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="flex-1 min-w-[300px]">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Filter by Event
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 flex gap-1 flex-wrap">
            {EVENT_FILTERS.map((e) => (
              <Button
                key={e}
                variant={activeEvent === e ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => buildQuery(activeStatus, e, undefined, 1)}
              >
                {e === "all" ? "All Events" : e}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-[220px]">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Filter by Integration
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <Select
              value={activeIntegrationId != null ? String(activeIntegrationId) : "all"}
              onValueChange={(val) =>
                buildQuery(
                  activeStatus,
                  activeEvent,
                  val === "all" ? null : Number(val),
                  1,
                )
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All integrations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All integrations</SelectItem>
                {integrationOptions.map((opt) => (
                  <SelectItem key={opt.id} value={String(opt.id)}>
                    {opt.label}
                  </SelectItem>
                ))}
                {integrationOptions.length === 0 && (
                  <SelectItem value="all" disabled>
                    (loads as rows appear)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between py-4 px-6">
          <CardTitle className="text-base">
            Deliveries
            <span className="ml-2 text-muted-foreground text-sm font-normal">
              ({total.toLocaleString()}{hasFilters ? " filtered" : " total"})
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[60px]">ID</TableHead>
                <TableHead>Integration</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-center">Attempt</TableHead>
                <TableHead>Delivery ID</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                    No deliveries found
                    {hasFilters
                      ? " for the current filters"
                      : ". Deliveries will appear here after the first outbound event is dispatched."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const success = isSuccess(row.status_code);
                  return (
                    <TableRow
                      key={row.id}
                      className={!success ? "bg-red-500/[0.03]" : undefined}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell>
                        <button
                          className="text-sm font-medium hover:underline text-left"
                          onClick={() =>
                            buildQuery(
                              activeStatus,
                              activeEvent,
                              activeIntegrationId === row.integration_id
                                ? null
                                : row.integration_id,
                              1,
                            )
                          }
                          title={`Filter by integration #${row.integration_id}`}
                        >
                          {row.integration_name ?? `Integration #${row.integration_id}`}
                        </button>
                        {row.integration_provider && (
                          <div className="text-xs text-muted-foreground">{row.integration_provider}</div>
                        )}
                        {row.is_test === 1 && (
                          <Badge variant="outline" className="text-[10px] h-4 mt-0.5">test</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <EventBadge event={row.event} />
                      </TableCell>
                      <TableCell>
                        <DeliveryStatusBadge statusCode={row.status_code} />
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {row.response_ms != null ? `${row.response_ms}ms` : "—"}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {row.attempt > 1 ? (
                          <span className="text-amber-600 font-medium">{row.attempt}</span>
                        ) : (
                          <span className="text-muted-foreground">1</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {row.delivery_id.slice(0, 8)}…
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(row.occurred_at), "MMM d, HH:mm:ss")}
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        {row.last_error ? (
                          <span
                            className="text-xs text-destructive truncate block"
                            title={row.last_error}
                          >
                            {row.last_error.slice(0, 60)}
                            {row.last_error.length > 60 ? "…" : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={isResending}
                          onClick={() => resend({ id: row.id })}
                          title="Re-fire this payload with a fresh timestamp"
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Resend
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => buildQuery(activeStatus, activeEvent, undefined, page - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => buildQuery(activeStatus, activeEvent, undefined, page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
