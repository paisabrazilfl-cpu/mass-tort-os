import { useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useListLeads,
  getListLeadsQueryKey,
  ListLeadsStatus,
  useListVendors,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
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
import { useAuth } from "@/contexts/auth-context";

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

// Humanize a raw `source` string (e.g. "operator_intake") into a readable label.
function humanizeSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const known: Record<string, string> = {
    operator_intake: "Operator Intake",
    web_form: "Web Form",
    form: "Web Form",
    n8n: "n8n Automation",
    api: "API",
    import: "CSV Import",
    csv_import: "CSV Import",
    manual: "Manual Entry",
  };
  const key = source.toLowerCase();
  if (known[key]) return known[key];
  return source
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Pull a site/landing/referrer hint out of the lead's custom_fields JSON so the
// operator can see *where* a web lead came from beyond just the vendor.
function extractSiteHint(custom: unknown): string | null {
  if (!custom || typeof custom !== "object") return null;
  const cf = custom as Record<string, unknown>;
  const keys = ["site", "utm_source", "source_url", "landing_page", "referrer", "utm_campaign"];
  for (const k of keys) {
    const v = cf[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// The forward pipeline stages every lead moves through, in order.
const PIPELINE_STAGES = ["new", "qualified", "signed"] as const;

// Renders a compact 3-step pipeline progress so the operator can see where a
// lead sits at a glance. Rejected/review_required are off-pipeline states and
// get their own treatment.
function StageCell({ status }: { status: string }) {
  if (status === "rejected") {
    return (
      <div className="flex flex-col gap-1" data-testid="stage-rejected">
        <div className="flex items-center gap-1">
          {PIPELINE_STAGES.map((_, i) => (
            <span key={i} className="h-1.5 w-6 rounded-full bg-rose-400/70" />
          ))}
        </div>
        <span className="text-xs font-medium text-rose-600">Rejected</span>
      </div>
    );
  }

  if (status === "review_required") {
    return (
      <div className="flex flex-col gap-1" data-testid="stage-review">
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-6 rounded-full bg-amber-500" />
          <span className="h-1.5 w-6 rounded-full bg-amber-500" />
          <span className="h-1.5 w-6 rounded-full bg-muted" />
        </div>
        <span className="text-xs font-medium text-amber-600">Needs Review</span>
      </div>
    );
  }

  const currentIdx = PIPELINE_STAGES.indexOf(status as (typeof PIPELINE_STAGES)[number]);
  const label =
    currentIdx === 0 ? "New" : currentIdx === 1 ? "Qualified" : currentIdx === 2 ? "Signed" : "—";

  return (
    <div className="flex flex-col gap-1" data-testid={`stage-${status}`}>
      <div className="flex items-center gap-1">
        {PIPELINE_STAGES.map((_, i) => (
          <span
            key={i}
            className={
              "h-1.5 w-6 rounded-full " +
              (currentIdx >= 0 && i <= currentIdx ? "bg-emerald-500" : "bg-muted")
            }
          />
        ))}
      </div>
      <span className="text-xs font-medium text-foreground">
        {label}
        <span className="text-muted-foreground">
          {currentIdx >= 0 ? ` · ${currentIdx + 1}/${PIPELINE_STAGES.length}` : ""}
        </span>
      </span>
    </div>
  );
}

export default function Leads() {
  const searchString = useSearch();
  const urlParams = new URLSearchParams(searchString);
  const tortFilter = urlParams.get("tort_type") ?? "";
  // Per-site lead filter: SITES "View leads" links here with a stable
  // `source=web_form_<slug>` plus a `label` for human-friendly banner display.
  const sourceFilter = urlParams.get("source") ?? "";
  const sourceLabel = urlParams.get("label") ?? "";
  const [search, setSearch] = useState(urlParams.get("search") ?? "");
  const [status, setStatus] = useState<ListLeadsStatus | "all">("all");
  const [exportOpen, setExportOpen] = useState(false);

  const params = {
    ...(search ? { search } : {}),
    ...(status !== "all" ? { status: status as ListLeadsStatus } : {}),
    ...(tortFilter ? { tort_type: tortFilter } : {}),
    ...(sourceFilter ? { source: sourceFilter } : {}),
  };

  const { data: leads, isLoading } = useListLeads(params, {
    query: { queryKey: getListLeadsQueryKey(params) }
  });

  // Vendor names are resolved client-side to label the Source column. The
  // /vendors route is gated by `vendors:view`, which agent/viewer roles lack,
  // so we only run the lookup for roles that can read it. The Source column
  // falls back to the raw source channel when no vendor name is available, and
  // the query is marked non-fatal so a stray 403 never raises an error toast.
  const { user } = useAuth();
  const canViewVendors =
    !!user &&
    ["super_admin", "admin", "user_manager", "attorney", "paralegal"].includes(user.role);
  const { data: vendors } = useListVendors({
    query: {
      queryKey: getListVendorsQueryKey(),
      enabled: canViewVendors,
      retry: false,
      meta: { suppressErrorToast: true },
    },
  });
  const vendorNameById = new Map<number, string>(
    (vendors ?? []).map((v) => [v.id, v.name]),
  );

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

      {(tortFilter || sourceFilter) && (
        <div className="flex items-center gap-2 text-sm">
          {tortFilter && (
            <Badge variant="secondary" className="gap-1">
              Tort: {tortFilter}
            </Badge>
          )}
          {sourceFilter && (
            <Badge variant="secondary" className="gap-1">
              Site: {sourceLabel || sourceFilter}
            </Badge>
          )}
          <Link href="/leads" className="text-muted-foreground underline-offset-4 hover:underline">
            Clear filter
          </Link>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Tort</TableHead>
              <TableHead>Stage</TableHead>
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
                  <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : leads?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
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
                  <TableCell>
                    {(() => {
                      const vendorName =
                        lead.vendor_id != null ? vendorNameById.get(lead.vendor_id) : undefined;
                      const sourceLabel = humanizeSource(lead.source);
                      const siteHint = extractSiteHint((lead as any).custom_fields);
                      const primary = vendorName ?? sourceLabel;
                      // Secondary line: prefer a site/landing hint; otherwise, if a
                      // vendor name is the primary, show the raw source channel.
                      const secondary =
                        siteHint ?? (vendorName ? sourceLabel : null);
                      if (!primary && !secondary) {
                        return <span className="text-muted-foreground">—</span>;
                      }
                      return (
                        <div data-testid={`lead-source-${lead.id}`}>
                          <div className="text-sm">{primary ?? "—"}</div>
                          {secondary && primary !== secondary ? (
                            <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                              {secondary}
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell>{lead.tort_type}</TableCell>
                  <TableCell>
                    <StageCell status={lead.status} />
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
