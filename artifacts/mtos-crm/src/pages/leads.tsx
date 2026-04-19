import { useState } from "react";
import { Link } from "wouter";
import { useListLeads, getListLeadsQueryKey, ListLeadsStatus } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Search, Plus, Download } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [exportStatus, setExportStatus] = useState("all");
  const [tortType, setTortType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [lawFirm, setLawFirm] = useState("");
  const [clientId, setClientId] = useState("");
  const [selectedFields, setSelectedFields] = useState("all");

  const handleExport = () => {
    const params = new URLSearchParams();
    if (exportStatus !== "all") params.set("status", exportStatus);
    if (tortType) params.set("tort_type", tortType);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (lawFirm) params.set("law_firm", lawFirm);
    if (clientId) params.set("client_id", clientId);
    if (selectedFields !== "all") params.set("fields", selectedFields);

    const url = `/api/leads/export?${params.toString()}`;
    window.open(url, "_blank");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export Leads</DialogTitle>
          <DialogDescription>Configure filters and download leads as CSV.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={exportStatus} onValueChange={setExportStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="signed">Signed</SelectItem>
                  <SelectItem value="review_required">Review Required</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Tort Type</Label>
              <Input placeholder="e.g. Camp Lejeune" value={tortType} onChange={(e) => setTortType(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Date From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Date To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Law Firm</Label>
              <Input placeholder="Filter by law firm" value={lawFirm} onChange={(e) => setLawFirm(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Client ID</Label>
              <Input placeholder="Filter by client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Fields</Label>
            <Select value={selectedFields} onValueChange={setSelectedFields}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Fields</SelectItem>
                <SelectItem value="id,name,email,phone,tort_type,status,created_at">Basic Info</SelectItem>
                <SelectItem value="id,name,email,phone,tort_type,status,vendor_id,law_firm,client_id,created_at">With Vendor Info</SelectItem>
                <SelectItem value="id,first_name,last_name,email,phone_primary,tort_type,status,diagnosis,diagnosis_date,created_at">Clinical</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleExport} className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Download CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Leads() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListLeadsStatus | "all">("all");
  const [exportOpen, setExportOpen] = useState(false);
  
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
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setExportOpen(true)} className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button asChild>
            <Link href="/leads/new" className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              New Intake
            </Link>
          </Button>
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />

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
            <SelectItem value="review_required">Review Required</SelectItem>
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
              <TableHead>Convexity</TableHead>
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
                <TableCell colSpan={6} className="h-24 text-center">
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
                      lead.status === "rejected" ? "destructive" :
                      lead.status === "review_required" ? "secondary" : "outline"
                    } className={lead.status === "review_required" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}>
                      {lead.status === "review_required" ? "REVIEW" : lead.status.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const c = (lead as any).convexity_score as string | null | undefined;
                      const flags = (((lead as any).convexity_ruin_flags ?? []) as string[]).length;
                      if (flags > 0) return <Badge className="bg-rose-100 text-rose-800 border-rose-300" data-testid={`badge-convexity-${lead.id}`}>RUIN</Badge>;
                      if (c === "convex") return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300" data-testid={`badge-convexity-${lead.id}`}>Convex</Badge>;
                      if (c === "concave") return <Badge className="bg-amber-100 text-amber-800 border-amber-300" data-testid={`badge-convexity-${lead.id}`}>Concave</Badge>;
                      if (c === "neutral") return <Badge variant="secondary" data-testid={`badge-convexity-${lead.id}`}>Neutral</Badge>;
                      return <Badge variant="outline" data-testid={`badge-convexity-${lead.id}`}>—</Badge>;
                    })()}
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
