import { useState } from "react";
import { getAccessToken } from "@/lib/auth-store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Bot, RefreshCw, Loader2, CheckCircle, XCircle, AlertTriangle, Search,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = (path: string) => `/api/dialer${path}`;

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(API(path), {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

type TortAgent = {
  tort_id: string;
  tort_label: string;
  vapi_assistant_id: string | null;
  status: string;
  prompt_fingerprint: string | null;
  current_fingerprint: string;
  out_of_date: boolean;
  last_synced_at: string | null;
  last_error: string | null;
};

function StatusBadge({ agent }: { agent: TortAgent }) {
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
        <CheckCircle className="h-3 w-3" /> Active
      </Badge>
    );
  }
  return <Badge variant="secondary">Not provisioned</Badge>;
}

export default function VoiceAgentsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [provisioningId, setProvisioningId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tort-agents"],
    queryFn: () => apiFetch<{ agents: TortAgent[] }>("/tort-agents"),
  });

  const provisionOne = useMutation({
    mutationFn: (tortId: string) =>
      apiFetch(`/tort-agents/${encodeURIComponent(tortId)}/provision`, { method: "POST" }),
    onMutate: (tortId: string) => setProvisioningId(tortId),
    onSettled: () => setProvisioningId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tort-agents"] });
      toast({ title: "Agent synced" });
    },
    onError: (e: Error) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const provisionAll = useMutation({
    mutationFn: () => apiFetch<{ summary: Record<string, number> }>("/tort-agents/provision-all", { method: "POST" }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["tort-agents"] });
      const s = res.summary;
      toast({
        title: "Provisioning complete",
        description: `${s.created} created · ${s.updated} updated · ${s.in_sync} in sync · ${s.errors} errors`,
      });
    },
    onError: (e: Error) => toast({ title: "Provisioning failed", description: e.message, variant: "destructive" }),
  });

  const syncOutOfDate = useMutation({
    mutationFn: () => apiFetch<{ summary: Record<string, number> }>("/tort-agents/sync-out-of-date", { method: "POST" }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["tort-agents"] });
      const s = res.summary;
      if (s.total === 0) {
        toast({ title: "Nothing to sync", description: "All agents are already up to date." });
        return;
      }
      toast({
        title: "Out-of-date agents synced",
        description: `${s.total} targeted · ${s.created} created · ${s.updated} updated · ${s.in_sync} in sync · ${s.errors} errors`,
        ...(s.errors > 0 ? { variant: "destructive" as const } : {}),
      });
    },
    onError: (e: Error) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const agents: TortAgent[] = data?.agents ?? [];
  const filtered = agents.filter(
    (a) =>
      a.tort_label.toLowerCase().includes(search.toLowerCase()) ||
      a.tort_id.toLowerCase().includes(search.toLowerCase()),
  );

  const counts = {
    active: agents.filter((a) => a.status === "active" && !a.out_of_date).length,
    outOfDate: agents.filter((a) => a.status === "active" && a.out_of_date).length,
    notProvisioned: agents.filter((a) => a.status === "not_provisioned").length,
    error: agents.filter((a) => a.status === "error").length,
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="h-6 w-6" /> Voice Agents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            One dedicated Vapi assistant per tort, provisioned with a tort-specific prompt and eligibility logic.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => syncOutOfDate.mutate()}
            disabled={syncOutOfDate.isPending || provisionAll.isPending || counts.outOfDate === 0}
            title={counts.outOfDate === 0 ? "No agents are out of date" : undefined}
          >
            {syncOutOfDate.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <AlertTriangle className="h-4 w-4 mr-2" />
            )}
            Sync out-of-date{counts.outOfDate > 0 ? ` (${counts.outOfDate})` : ""}
          </Button>
          <Button onClick={() => provisionAll.mutate()} disabled={provisionAll.isPending || syncOutOfDate.isPending}>
            {provisionAll.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Provision All
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-green-600">{counts.active}</p><p className="text-xs text-muted-foreground">Active</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-amber-600">{counts.outOfDate}</p><p className="text-xs text-muted-foreground">Out of date</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-muted-foreground">{counts.notProvisioned}</p><p className="text-xs text-muted-foreground">Not provisioned</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-2xl font-semibold text-destructive">{counts.error}</p><p className="text-xs text-muted-foreground">Errors</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-Tort Agents</CardTitle>
          <CardDescription>{agents.length} torts in the registry</CardDescription>
          <div className="relative mt-2 max-w-xs">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search torts…"
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
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tort</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assistant ID</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
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
                    <TableCell><StatusBadge agent={a} /></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {a.vapi_assistant_id ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.last_synced_at ? new Date(a.last_synced_at).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={provisioningId === a.tort_id}
                        onClick={() => provisionOne.mutate(a.tort_id)}
                      >
                        {provisioningId === a.tort_id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 mr-1" />
                            {a.status === "not_provisioned" ? "Provision" : "Sync"}
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No torts match your search.
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
