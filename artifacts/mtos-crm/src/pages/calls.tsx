import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Phone, RefreshCw, Loader2, ChevronLeft, ChevronRight, AlertCircle,
} from "lucide-react";
import {
  useListCalls,
  useGetCall,
  ListCallsStatus,
  getListCallsQueryKey,
  getGetCallQueryKey,
} from "@workspace/api-client-react";
import { keepPreviousData } from "@tanstack/react-query";

type CallStatus = ListCallsStatus;

interface TranscriptTurn {
  role?: string;
  content?: string;
  ts?: string;
}

const PAGE_SIZE = 25;

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function statusBadge(s: string | null | undefined) {
  if (s === "completed") return <Badge className="bg-emerald-600 hover:bg-emerald-700">completed</Badge>;
  if (s === "in_progress") return <Badge className="bg-sky-600 hover:bg-sky-700">in progress</Badge>;
  if (s === "failed") return <Badge variant="destructive">failed</Badge>;
  if (s === "no_answer") return <Badge variant="secondary">no answer</Badge>;
  return <Badge variant="outline">{s ?? "unknown"}</Badge>;
}

export default function CallsPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<CallStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  // Date range filter (T006 round-4 / blocker reopened by architect): both
  // bounds are inclusive against call_logs.started_at. Stored as
  // <input type="date"> "YYYY-MM-DD" strings; the server parses to Date.
  // start_date is broadened to start-of-day and end_date to end-of-day so
  // the UI matches operator expectations ("show me calls on Apr 26").
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [openCallId, setOpenCallId] = useState<number | null>(null);

  // Generated React Query hooks (T006). Permission.CALLS_VIEW gates both endpoints
  // server-side; a 4xx is surfaced as `error`, not silently retried.
  // `placeholderData: keepPreviousData` keeps the table populated during pagination
  // (React Query v5 replacement for the old `keepPreviousData: true` flag).
  // Convert "YYYY-MM-DD" inputs to ISO timestamps that bracket the chosen
  // local-day so the server's started_at >=/<= comparison matches operator
  // intent. We send ISO 8601 strings (orval generates `string` for these
  // params per OpenAPI format: date-time).
  const startIso = startDate ? new Date(`${startDate}T00:00:00`).toISOString() : undefined;
  const endIso = endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : undefined;
  const listParams = {
    page,
    page_size: PAGE_SIZE,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(search ? { search } : {}),
    ...(startIso ? { start_date: startIso } : {}),
    ...(endIso ? { end_date: endIso } : {}),
  };
  const listQ = useListCalls(listParams, {
    query: {
      queryKey: getListCallsQueryKey(listParams),
      retry: false,
      placeholderData: keepPreviousData,
    },
  });

  // openCallId !== null gates the detail fetch — keeps the drawer empty until opened.
  const detailCallId = openCallId ?? 0;
  const detailQ = useGetCall(detailCallId, {
    query: {
      queryKey: getGetCallQueryKey(detailCallId),
      enabled: openCallId !== null,
      retry: false,
    },
  });

  const rows = listQ.data?.data.rows ?? [];
  const total = listQ.data?.data.total ?? 0;
  const loading = listQ.isFetching;
  const error =
    listQ.error instanceof Error ? listQ.error.message : null;

  const detail = detailQ.data?.data ?? null;
  const detailLoading = detailQ.isFetching;

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total],
  );

  function load() {
    void listQ.refetch();
  }

  function openDetail(id: number) {
    setOpenCallId(id);
  }

  function applySearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4" data-testid="page-calls">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Phone className="w-6 h-6" /> Calls
          </h1>
          <p className="text-sm text-muted-foreground">
            Inbound and outbound voice calls handled by the Vapi assistant.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-refresh-calls">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setPage(1);
                  setStatusFilter(v as CallStatus | "all");
                }}
              >
                <SelectTrigger className="w-44" data-testid="select-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="in_progress">In progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="no_answer">No answer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="call-start-date" className="text-xs text-muted-foreground">
                Start date
              </Label>
              <Input
                id="call-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setPage(1);
                  setStartDate(e.target.value);
                }}
                className="w-44"
                data-testid="input-call-start-date"
              />
            </div>
            <div>
              <Label htmlFor="call-end-date" className="text-xs text-muted-foreground">
                End date
              </Label>
              <Input
                id="call-end-date"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setPage(1);
                  setEndDate(e.target.value);
                }}
                className="w-44"
                data-testid="input-call-end-date"
              />
            </div>
            {(startDate || endDate) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStartDate("");
                  setEndDate("");
                  setPage(1);
                }}
                data-testid="button-clear-date-range"
              >
                Clear dates
              </Button>
            )}
            <form onSubmit={applySearch} className="flex items-end gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Search</Label>
                <Input
                  placeholder="phone, vapi call id…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="w-64"
                  data-testid="input-call-search"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" data-testid="button-call-search">
                Search
              </Button>
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              )}
            </form>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="p-4 flex items-start gap-2 text-destructive">
            <AlertCircle className="w-5 h-5 mt-0.5" />
            <div>
              <p className="font-medium">Could not load calls</p>
              <p className="text-sm">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Vapi call</TableHead>
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground" data-testid="text-no-calls">
                    No calls match your filters.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id} data-testid={`row-call-${r.id}`}>
                  <TableCell className="text-xs">{formatDateTime(r.started_at ?? r.created_at)}</TableCell>
                  <TableCell className="text-xs">{r.direction}</TableCell>
                  <TableCell className="text-xs font-mono">{r.from_number ?? "—"}</TableCell>
                  <TableCell className="text-xs font-mono">{r.to_number ?? "—"}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell className="text-xs">{formatDuration(r.duration_seconds)}</TableCell>
                  <TableCell className="text-xs font-mono truncate max-w-[180px]">{r.vapi_call_id ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openDetail(r.id)}
                      data-testid={`button-open-call-${r.id}`}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <div className="text-muted-foreground">
          {total > 0 ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : "0 results"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            data-testid="button-page-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="font-medium" data-testid="text-page-label">
            Page {page} / {totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            data-testid="button-page-next"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Sheet
        open={openCallId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenCallId(null);
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto" data-testid="sheet-call-detail">
          <SheetHeader>
            <SheetTitle>Call detail</SheetTitle>
            <SheetDescription>
              Vapi call {detail?.vapi_call_id ?? openCallId}
            </SheetDescription>
          </SheetHeader>

          {detailLoading && (
            <div className="flex items-center gap-2 mt-4 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading call…
            </div>
          )}

          {detail && (
            <div className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <div>{statusBadge(detail.status)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Duration</Label>
                  <div>{formatDuration(detail.duration_seconds)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Started</Label>
                  <div>{formatDateTime(detail.started_at)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Ended</Label>
                  <div>{formatDateTime(detail.ended_at)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <div className="font-mono">{detail.from_number ?? "—"}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Lead</Label>
                  <div>
                    {detail.lead_id ? (
                      <a className="text-primary hover:underline" href={`/leads/${detail.lead_id}`}>
                        {[detail.lead_first_name, detail.lead_last_name].filter(Boolean).join(" ") ||
                          `Lead #${detail.lead_id}`}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">unmatched</span>
                    )}
                  </div>
                </div>
              </div>

              {detail.recording_url && (
                <div>
                  <Label className="text-xs text-muted-foreground">Recording</Label>
                  <audio
                    controls
                    src={detail.recording_url}
                    className="w-full mt-1"
                    data-testid="audio-recording"
                  >
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )}

              {detail.intake_result != null ? (
                <div>
                  <Label className="text-xs text-muted-foreground">Intake result</Label>
                  <pre
                    className="bg-muted/40 rounded p-2 text-xs overflow-x-auto max-h-72"
                    data-testid="text-intake-result"
                  >
                    {JSON.stringify(detail.intake_result, null, 2)}
                  </pre>
                </div>
              ) : null}

              {(() => {
                // Vapi transcript shape is provider-defined; the OpenAPI schema
                // intentionally types it as `unknown`. Narrow defensively —
                // drop nulls and primitives so a malformed turn cannot crash
                // the renderer when it tries to read `t.role` etc.
                const rawTranscript = Array.isArray(detail.transcript) ? detail.transcript : [];
                const transcript: TranscriptTurn[] = rawTranscript.filter(
                  (t): t is TranscriptTurn => t != null && typeof t === "object",
                );
                return (
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Transcript ({transcript.length} turns)
                    </Label>
                    <div
                      className="border rounded p-2 max-h-96 overflow-y-auto space-y-2 text-sm"
                      data-testid="container-transcript"
                    >
                      {transcript.length > 0 ? (
                        transcript.map((t, i) => (
                          <div
                            key={i}
                            className={`flex gap-2 ${t.role === "user" || t.role === "customer" ? "" : "flex-row-reverse text-right"}`}
                          >
                            <Badge variant="outline" className="shrink-0">{t.role ?? "?"}</Badge>
                            <div className="flex-1">
                              <div>{t.content ?? ""}</div>
                              {t.ts && (
                                <div className="text-[10px] text-muted-foreground">{formatDateTime(t.ts)}</div>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-muted-foreground text-xs italic">No transcript yet.</div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {detail.error && (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  <strong>Error:</strong> {detail.error}
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
