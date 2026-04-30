import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListCases, useGetQueueStats } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Briefcase, AlertCircle, CheckCircle, Clock, Search, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

function getStatusBadge(status: string) {
  switch (status) {
    case "open":
      return <Badge variant="secondary" className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20">Open</Badge>;
    case "processing":
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"><Clock className="w-3 h-3 mr-1" />Processing</Badge>;
    case "analyzed":
      return <Badge variant="secondary" className="bg-green-500/10 text-green-500 hover:bg-green-500/20"><CheckCircle className="w-3 h-3 mr-1" />Analyzed</Badge>;
    case "failed":
      return <Badge variant="destructive" className="bg-red-500/10 text-red-500 hover:bg-red-500/20"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function Cases() {
  const [, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  
  const { data: cases = [], isLoading } = useListCases();
  const { data: queueStats } = useGetQueueStats({ 
    query: { refetchInterval: 5000 } as any
  });

  const filteredCases = cases.filter(c => 
    c.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (c.data?.patient_name as string)?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (c.data?.tort_type as string)?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">Case Pipeline</h2>
          <p className="text-muted-foreground mt-1">Distributed case analysis and processing.</p>
        </div>
        <div className="flex items-center space-x-2">
          <Button onClick={() => setLocation("/cases/new")}>
            <Plus className="mr-2 h-4 w-4" />
            Submit Case
          </Button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Background Worker Queue
          </h3>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLocation("/job-queue")}>
            View all jobs →
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Job-processor status across all queued case-analysis jobs (not the
          same as case statuses below). Click a card to filter by status.
        </p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {queueStats ? (
            Object.entries(queueStats).map(([key, count]) => (
              <Card
                key={key}
                className="bg-card cursor-pointer hover:shadow-md transition-all hover:ring-1 hover:ring-primary/30"
                onClick={() => setLocation(`/job-queue?status=${key}`)}
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    Worker · {key}
                  </CardTitle>
                  <Briefcase className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{count}</div>
                  <p className="text-xs text-primary mt-1">View jobs →</p>
                </CardContent>
              </Card>
            ))
          ) : (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-4" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-1/4" />
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
          <CardTitle>Distributed Cases</CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search cases..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[120px]">Case ID</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Tort Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : filteredCases.length > 0 ? (
                filteredCases.map((caseItem) => (
                  <TableRow 
                    key={caseItem.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setLocation(`/cases/${caseItem.id}`)}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {caseItem.id.substring(0, 8)}...
                    </TableCell>
                    <TableCell className="font-medium">
                      {(caseItem.data?.patient_name as string) || "Unknown"}
                    </TableCell>
                    <TableCell>
                      {(caseItem.data?.tort_type as string) || "Unknown"}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(caseItem.status)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">
                      {format(new Date(caseItem.created_at), "MMM d, yyyy")}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No cases found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
