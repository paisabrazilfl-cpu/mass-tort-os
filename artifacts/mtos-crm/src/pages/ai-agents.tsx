import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getAccessToken } from "@/lib/auth-store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Bot, Loader2, PhoneCall, Search, Sparkles, Radio, AlertTriangle,
  CheckCircle, XCircle, RefreshCw,
} from "lucide-react";

const API = (path: string) => `/api/dialer${path}`;

async function apiFetch<T>(path: string): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(API(path), {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

type AgentActivity = {
  total_calls: number;
  active_calls: number;
  completed_today: number;
  failed_today: number;
  inbound_today: number;
  outbound_today: number;
  last_call_at: string | null;
  last_call_status: string | null;
  last_call_direction: string | null;
};

type AgentRow = {
  tort_id: string;
  tort_label: string;
  vapi_assistant_id: string | null;
  status: string;
  out_of_date: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  activity: AgentActivity;
};

type LiveCall = {
  id: number;
  tort_type: string | null;
  vapi_assistant_id: string | null;
  status: string;
  direction: string;
  number: string | null;
  lead_name: string | null;
  started_at: string | null;
  duration_seconds: number | null;
};

type ActivityResponse = {
  summary: {
    total_agents: number;
    working_agents: number;
    active_agents: number;
    error_agents: number;
    live_calls: number;
    calls_today: number;
  };
  agents: AgentRow[];
  live_calls: LiveCall[];
};

function AgentStateBadge({ agent }: { agent: AgentRow }) {
  if (agent.activity.active_calls > 0) {
    return (
      <Badge variant="outline" className="gap-1 border-sky-500 text-sky-600">
        <Radio className="h-3 w-3 animate-pulse" /> On a call
      </Badge>
    );
  }
  if (agent.status === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Error
      </Badge>
    );
  }
  if (agent.status === "active" && agent.out_of_date) {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
        <AlertTriangle className="h-3 w-3" /> Out of date
      </Badge>
    );
  }
  if (agent.status === "active") {
    return (
      <Badge variant="outline" className="gap-1 border-green-500 text-green-600">
        <CheckCircle className="h-3 w-3" /> Idle
      </Badge>
    );
  }
  return <Badge variant="secondary">Not provisioned</Badge>;
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function AiAgentsPage() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["tort-agents-activity"],
    queryFn: () => apiFetch<ActivityResponse>("/tort-agents/activity"),
    refetchInterval: 10_000,
  });

  const errorMessage =
    error instanceof Error ? error.message : "Couldn't load agent activity.";

  const summary = data?.summary;
  const agents = data?.agents ?? [];
  const liveCalls = data?.live_calls ?? [];

  const labelFor = (assistantId: string | null, tortType: string | null) => {
    const byAssistant = assistantId
      ? agents.find((a) => a.vapi_assistant_id === assistantId)
      : undefined;
    const byTort = tortType ? agents.find((a) => a.tort_id === tortType) : undefined;
    return (byAssistant ?? byTort)?.tort_label ?? tortType ?? "Unknown agent";
  };

  const filtered = agents.filter(
    (a) =>
      a.tort_label.toLowerCase().includes(search.toLowerCase()) ||
      a.tort_id.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Bot className="h-6 w-6" /> AI Agents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live view of your per-tort Vapi voice agents — which are working right
            now and what each one is doing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setLocation("/voice-agents")}>
            <Bot className="h-4 w-4 mr-2" /> Manage Agents
          </Button>
          <Button onClick={() => setLocation("/abby")}>
            <Sparkles className="h-4 w-4 mr-2" /> Open Abby
          </Button>
        </div>
      </div>

      {isError && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-sky-600">{summary?.working_agents ?? 0}</p><p className="text-xs text-muted-foreground">Working now</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-sky-600">{summary?.live_calls ?? 0}</p><p className="text-xs text-muted-foreground">Live calls</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-green-600">{summary?.active_agents ?? 0}</p><p className="text-xs text-muted-foreground">Active agents</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold">{summary?.calls_today ?? 0}</p><p className="text-xs text-muted-foreground">Calls today</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-destructive">{summary?.error_agents ?? 0}</p><p className="text-xs text-muted-foreground">Errors</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <PhoneCall className="h-4 w-4" /> Live Calls
          </CardTitle>
          <CardDescription>
            Calls currently in flight across all agents.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center text-destructive py-8 text-sm">
              {errorMessage}
            </div>
          ) : liveCalls.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">
              No agents are on a call right now.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {liveCalls.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {labelFor(c.vapi_assistant_id, c.tort_type)}
                    </TableCell>
                    <TableCell className="capitalize text-sm">{c.direction}</TableCell>
                    <TableCell className="text-sm">
                      {c.lead_name ?? c.number ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1 border-sky-500 text-sky-600">
                        <Radio className="h-3 w-3 animate-pulse" /> {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtTime(c.started_at)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtDuration(c.duration_seconds)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Activity</CardTitle>
          <CardDescription>
            {agents.length} per-tort agents · what each one is up to
          </CardDescription>
          <div className="relative mt-2 max-w-xs">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search agents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center text-destructive py-8 text-sm">
              {errorMessage}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Assistant ID</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  <TableHead className="text-right">Today (in / out)</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Last call</TableHead>
                  <TableHead>Last synced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={a.tort_id}>
                    <TableCell>
                      <div className="font-medium">{a.tort_label}</div>
                      <div className="text-xs text-muted-foreground">{a.tort_id}</div>
                      {a.last_error && (
                        <div className="text-xs text-destructive mt-0.5 max-w-md truncate" title={a.last_error}>
                          {a.last_error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell><AgentStateBadge agent={a} /></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {a.vapi_assistant_id ? (
                        <span title={a.vapi_assistant_id}>{a.vapi_assistant_id}</span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.activity.active_calls > 0 ? (
                        <span className="font-semibold text-sky-600">{a.activity.active_calls}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      <span className="text-green-600">{a.activity.completed_today}</span>
                      {a.activity.failed_today > 0 && (
                        <span className="text-destructive"> / {a.activity.failed_today}</span>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {a.activity.inbound_today} in / {a.activity.outbound_today} out
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                      {a.activity.total_calls}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.activity.last_call_at ? (
                        <>
                          <span className="capitalize">{a.activity.last_call_direction ?? ""}</span>{" "}
                          {a.activity.last_call_status ? `· ${a.activity.last_call_status}` : ""}
                          <div>{fmtTime(a.activity.last_call_at)}</div>
                        </>
                      ) : (
                        "No calls yet"
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.last_synced_at ? fmtTime(a.last_synced_at) : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No agents match your search.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
