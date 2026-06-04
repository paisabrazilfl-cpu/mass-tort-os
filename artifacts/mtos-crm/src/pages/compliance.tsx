import { useState } from "react";
import { useGetAuditTrail, useGetAuditSummary, getGetAuditTrailQueryKey, getGetAuditSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { format } from "date-fns";
import { Activity, AlertCircle, Clock } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";

export default function Compliance() {
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");

  const { data: summary, isLoading: summaryLoading } = useGetAuditSummary({
    query: { queryKey: getGetAuditSummaryQueryKey() }
  });

  const auditParams = {
    limit: 100,
    ...(entityTypeFilter !== "all" ? { entity_type: entityTypeFilter } : {}),
    ...(actionFilter !== "all" ? { action: actionFilter } : {})
  };

  const { data: trail, isLoading: trailLoading } = useGetAuditTrail(auditParams, {
    query: { queryKey: getGetAuditTrailQueryKey(auditParams) }
  });

  return (
    <div className="space-y-6">
      <WorkspaceHero
        eyebrow="Compliance"
        title="Audit Trail"
        description="Full immutable log of every action taken in the system — by operator, entity, and timestamp. Export for legal review at any time."
        badge="HIPAA-adjacent"
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">{summary?.total_events || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last 24h</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">{summary?.last_24h || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last 7 Days</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">{summary?.last_7d || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Event Log</CardTitle>
            <div className="flex gap-2">
              <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Entity Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Entities</SelectItem>
                  {summary?.by_entity?.map((e) => (
                    <SelectItem key={e.entity_type} value={e.entity_type}>
                      {e.entity_type} ({e.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {summary?.by_action?.map((a) => (
                    <SelectItem key={a.action} value={a.action}>
                      {a.action} ({a.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {trailLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto border rounded-md">
              <table className="w-full text-sm text-left font-mono">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
                  <tr>
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Occurred At</th>
                    <th className="px-4 py-3">Entity Type</th>
                    <th className="px-4 py-3">Entity ID</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(trail || []).map((row) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-muted-foreground">{row.id}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {format(new Date(row.occurred_at), "yyyy-MM-dd HH:mm:ss")}
                      </td>
                      <td className="px-4 py-3 text-primary">{row.entity_type}</td>
                      <td className="px-4 py-3">{row.entity_id}</td>
                      <td className="px-4 py-3">
                        <span className="bg-secondary text-secondary-foreground px-2 py-0.5 rounded text-xs">
                          {row.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 text-xs font-mono">
                              View JSON
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl">
                            <DialogHeader>
                              <DialogTitle>Audit Details</DialogTitle>
                              <DialogDescription>
                                Raw JSON payload captured for this audit log entry.
                              </DialogDescription>
                            </DialogHeader>
                            <div className="bg-muted p-4 rounded-md overflow-auto max-h-[60vh]">
                              <pre className="text-xs">
                                {JSON.stringify(row.details || {}, null, 2)}
                              </pre>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(!trail || trail.length === 0) && (
                <div className="text-center py-6 text-muted-foreground">
                  No audit events found for selected filters.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}