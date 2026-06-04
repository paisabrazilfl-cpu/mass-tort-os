import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useListLeads,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import { ShieldCheck, Search, UserSearch, ExternalLink } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BackgroundCheckHubCard } from "@/components/background-check-hub-card";

export default function BackgroundCheck() {
  const searchString = useSearch();
  const initialLeadId = useMemo(() => {
    const fromUrl = new URLSearchParams(searchString).get("leadId");
    const parsed = fromUrl ? Number(fromUrl) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [searchString]);

  const [search, setSearch] = useState("");
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(initialLeadId);

  useEffect(() => {
    if (initialLeadId !== null) setSelectedLeadId(initialLeadId);
  }, [initialLeadId]);

  const params = useMemo(() => (search.trim() ? { search: search.trim() } : {}), [search]);
  const { data: leads, isLoading } = useListLeads(params, {
    query: { queryKey: getListLeadsQueryKey(params) },
  });

  const selectedLead = useMemo(
    () => (leads ?? []).find((l) => l.id === selectedLeadId) ?? null,
    [leads, selectedLeadId],
  );

  return (
    <div className="p-6 space-y-6">
      <WorkspaceHero
        eyebrow="Verification"
        title="Background Check Hub"
        description="Nine-lane verification against any lead — address, email, phone, residency, criminal/court, incarceration, sex-offender registry, attorney conflict, and federal PACER."
        badge="9 lanes"
        actions={[{ label: "Run hub check", href: "#hub", icon: ShieldCheck }]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <UserSearch className="h-4 w-4" /> Select a lead
          </CardTitle>
          <CardDescription>
            Search by name, email, or phone, then choose a lead to run or review their background check.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bg-lead-search">Find lead</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="bg-lead-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Type a name, email, or phone number…"
                className="pl-9"
                data-testid="input-bg-lead-search"
              />
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (leads ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No leads match your search.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
              {(leads ?? []).slice(0, 50).map((lead) => {
                const active = lead.id === selectedLeadId;
                return (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => setSelectedLeadId(lead.id)}
                    className={
                      "w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 " +
                      (active ? "bg-primary/5" : "")
                    }
                    data-testid={`bg-lead-option-${lead.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{lead.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {lead.email || lead.phone || "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-xs">
                        {lead.tort_type}
                      </Badge>
                      {active && (
                        <Badge className="bg-primary/10 text-primary border border-primary/30 text-xs">
                          Selected
                        </Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {selectedLeadId ? (
        <div className="space-y-3">
          {selectedLead && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Running against{" "}
                <span className="font-medium text-foreground">{selectedLead.name}</span>
              </p>
              <Link
                href={`/leads/${selectedLeadId}`}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                Open full lead <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          )}
          <BackgroundCheckHubCard leadId={selectedLeadId} />
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-muted-foreground">
            <ShieldCheck className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">Select a lead above to run a background check.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
