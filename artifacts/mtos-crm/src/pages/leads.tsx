import { useState } from "react";
import { Link } from "wouter";
import { useListLeads, getListLeadsQueryKey, ListLeadsStatus } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

export default function Leads() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListLeadsStatus | "all">("all");
  
  const params = {
    ...(search ? { search } : {}),
    ...(status !== "all" ? { status: status as ListLeadsStatus } : {}),
  };

  const { data: leads, isLoading } = useListLeads(params, {
    query: { queryKey: getListLeadsQueryKey(params) }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Leads</h1>
        <Button asChild>
          <Link href="/leads/new" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New Intake
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search leads..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={(val: any) => setStatus(val)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="qualified">Qualified</SelectItem>
            <SelectItem value="signed">Signed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Tort</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : leads?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  No leads found.
                </TableCell>
              </TableRow>
            ) : (
              leads?.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="font-medium">
                    <div>{lead.name}</div>
                    <div className="text-xs text-muted-foreground">{lead.email || lead.phone}</div>
                  </TableCell>
                  <TableCell>{lead.tort_type}</TableCell>
                  <TableCell>
                    <Badge variant={
                      lead.status === "signed" ? "default" :
                      lead.status === "qualified" ? "secondary" :
                      lead.status === "rejected" ? "destructive" : "outline"
                    }>
                      {lead.status.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm font-mono">
                    {format(new Date(lead.created_at), "yyyy-MM-dd")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/leads/${lead.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
