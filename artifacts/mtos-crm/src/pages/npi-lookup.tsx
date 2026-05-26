import { useState } from "react";
import { Link } from "wouter";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  useSearchNpi,
  getSearchNpiQueryKey,
  SearchNpiParams,
  NpiProvider,
  useVerifyProviderMatch,
  NpiVerifyRichResult,
} from "@workspace/api-client-react";
import {
  Search,
  Stethoscope,
  ChevronDown,
  ChevronUp,
  MapPin,
  Phone,
  Building,
  User,
  Calendar,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Copy,
  Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", 
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", 
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", 
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", 
  "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

function ProviderRow({ provider }: { provider: NpiProvider }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <TableRow 
        className="cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="font-mono text-xs">{provider.npi}</TableCell>
        <TableCell className="font-medium">{provider.name}</TableCell>
        <TableCell>
          {provider.credential ? (
            <Badge variant="secondary" className="text-xs">
              {provider.credential}
            </Badge>
          ) : (
            <span className="text-muted-foreground text-xs">N/A</span>
          )}
        </TableCell>
        <TableCell className="max-w-[200px] truncate" title={provider.specialty}>
          {provider.specialty || <span className="text-muted-foreground">Unknown</span>}
        </TableCell>
        <TableCell>
          {provider.city}, {provider.state}
        </TableCell>
        <TableCell>{provider.phone || "N/A"}</TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end items-center gap-2">
            <a 
              href={provider.npi_registry_url} 
              target="_blank" 
              rel="noreferrer"
              className="text-xs text-primary hover:underline font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              View NPI Profile
            </a>
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={7} className="p-0 border-b">
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Primary Practice Address</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {provider.address_line_1}
                      {provider.address_line_2 && <><br />{provider.address_line_2}</>}
                      <br />
                      {provider.city}, {provider.state} {provider.postal_code}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <Phone className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Contact Information</p>
                    <div className="text-sm text-muted-foreground mt-1 space-y-1">
                      <p>Phone: {provider.phone || "N/A"}</p>
                      <p>Fax: {provider.fax || "N/A"}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  {provider.provider_type === "Individual" ? (
                    <User className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  ) : (
                    <Building className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Provider Details</p>
                    <div className="text-sm text-muted-foreground mt-1 space-y-1">
                      <p>Type: {provider.provider_type}</p>
                      {provider.gender && <p>Gender: {provider.gender}</p>}
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-2 pt-2 border-t border-border/50">
                  <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <div className="text-xs text-muted-foreground">
                    <p>Enumerated: {provider.enumeration_date ? new Date(provider.enumeration_date).toLocaleDateString() : "Unknown"}</p>
                    <p>Last Updated: {provider.last_updated ? new Date(provider.last_updated).toLocaleDateString() : "Unknown"}</p>
                  </div>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type VerifyFormState = {
  npi: string;
  name: string;
  organization: string;
  city: string;
  state: string;
  specialty: string;
};

const EMPTY_VERIFY_FORM: VerifyFormState = {
  npi: "",
  name: "",
  organization: "",
  city: "",
  state: "",
  specialty: "",
};

function pct(score?: number) {
  if (typeof score !== "number") return "—";
  return `${Math.round(score * 100)}%`;
}

function FieldRow({
  label,
  expected,
  actual,
  score,
  match,
}: {
  label: string;
  expected: string;
  actual: string;
  score?: number;
  match?: boolean;
}) {
  return (
    <div className="grid grid-cols-12 gap-3 py-2 items-center text-sm border-b border-border/30 last:border-0">
      <div className="col-span-2 text-muted-foreground font-medium">{label}</div>
      <div className="col-span-4">
        {expected ? (
          <span>{expected}</span>
        ) : (
          <span className="text-muted-foreground italic">not provided</span>
        )}
      </div>
      <div className="col-span-4 font-mono text-xs">
        {actual ? (
          <span>{actual}</span>
        ) : (
          <span className="text-muted-foreground italic">—</span>
        )}
      </div>
      <div className="col-span-1 text-center text-xs text-muted-foreground">
        {pct(score)}
      </div>
      <div className="col-span-1 text-right">
        {match === true ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500 inline" />
        ) : match === false ? (
          <XCircle className="h-4 w-4 text-destructive inline" />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}

function VerifyResultPanel({ result }: { result: NpiVerifyRichResult }) {
  const checks = result.checks ?? {};
  const provider = result.provider;
  const verified = result.verified;
  const confidencePct = Math.round((result.confidence ?? 0) * 100);

  // Pull out per-field check shapes (orval makes them all optional, so guard).
  const nameCheck = checks.name;
  const orgCheck = checks.organization;
  const locCheck = checks.location;
  const specCheck = checks.specialty;
  const decision = checks.decision_thresholds;
  const npiLookup = checks.npi_lookup;
  const search = checks.search;

  return (
    <Card className={`border ${verified ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              {verified ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  Verified Match
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Could Not Verify
                </>
              )}
            </CardTitle>
            <CardDescription>
              {result.method === "npi" && "Direct NPI lookup against CMS Registry."}
              {result.method === "name_search" && "Best fuzzy match from name + city + state search."}
              {!result.method && "No registry match was found for the provided criteria."}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums">{confidencePct}%</div>
            <div className="text-xs text-muted-foreground">confidence</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {provider && (
          <div className="rounded-md bg-background/60 border border-border/40 p-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              Registry record
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-medium">{provider.name || provider.organization_name || "—"}</div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5">NPI {provider.npi}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {provider.address?.address_1}
                  {provider.address?.city ? `, ${provider.address.city}` : ""}
                  {provider.address?.state ? `, ${provider.address.state}` : ""}
                  {provider.address?.postal_code ? ` ${provider.address.postal_code}` : ""}
                </div>
              </div>
              <a
                href={`https://npiregistry.cms.hhs.gov/provider-view/${provider.npi}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline whitespace-nowrap"
              >
                Open profile →
              </a>
            </div>
          </div>
        )}

        {(npiLookup?.error || search?.error) && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2">
            {npiLookup?.error ?? search?.error}
          </div>
        )}

        <div>
          <div className="grid grid-cols-12 gap-3 py-2 text-xs uppercase tracking-wide text-muted-foreground border-b border-border/50">
            <div className="col-span-2">Field</div>
            <div className="col-span-4">Expected</div>
            <div className="col-span-4">Registry</div>
            <div className="col-span-1 text-center">Score</div>
            <div className="col-span-1 text-right">Match</div>
          </div>
          <FieldRow
            label="Name"
            expected={nameCheck?.expected ?? ""}
            actual={nameCheck?.provider ?? ""}
            score={nameCheck?.score}
            match={nameCheck?.match}
          />
          {orgCheck && (orgCheck.expected || orgCheck.provider) && (
            <FieldRow
              label="Org"
              expected={orgCheck.expected ?? ""}
              actual={orgCheck.provider ?? ""}
              score={orgCheck.score}
              match={orgCheck.match}
            />
          )}
          <FieldRow
            label="City"
            expected={locCheck?.expected_city ?? ""}
            actual={locCheck?.provider_city ?? ""}
            score={locCheck?.city_score}
            match={locCheck?.city_match}
          />
          <FieldRow
            label="State"
            expected={locCheck?.expected_state ?? ""}
            actual={locCheck?.provider_state ?? ""}
            score={locCheck?.state_score}
            match={locCheck?.state_match}
          />
          <FieldRow
            label="Specialty"
            expected={specCheck?.expected_specialty ?? ""}
            actual={
              specCheck?.taxonomy_matches && specCheck.taxonomy_matches.length > 0
                ? specCheck.taxonomy_matches.map((t: { desc: string }) => t.desc).join(", ")
                : (specCheck?.all_taxonomies ?? []).slice(0, 3).join(", ")
            }
            match={specCheck?.match}
          />
        </div>

        {decision && (
          <div className="text-xs space-y-1 pt-1">
            <div className="text-muted-foreground uppercase tracking-wide mb-1">Decision thresholds</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Badge variant={decision.identity_ok ? "default" : "outline"} className="justify-between gap-2">
                Identity {pct(decision.identity_score)}
                {decision.identity_ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              </Badge>
              <Badge variant={decision.city_ok ? "default" : "outline"} className="justify-between gap-2">
                City {pct(decision.city_score)}
                {decision.city_ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              </Badge>
              <Badge variant={decision.state_ok ? "default" : "outline"} className="justify-between gap-2">
                State {pct(decision.state_score)}
                {decision.state_ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              </Badge>
              <Badge variant={decision.specialty_ok ? "default" : "outline"} className="justify-between gap-2">
                Specialty
                {decision.specialty_ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              </Badge>
            </div>
          </div>
        )}

        {result.method === "name_search" && typeof result.candidates_returned === "number" && (
          <p className="text-xs text-muted-foreground">
            Searched {result.candidates_returned} candidate{result.candidates_returned === 1 ? "" : "s"} from the registry.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Local NPPES DB types ────────────────────────────────────────────────────

type LocalProviderTaxonomy = { code: string; primary?: boolean; license?: string; state?: string };

type LocalProvider = {
  npi: string;
  entity_type: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  credential: string | null;
  org_name: string | null;
  practice_city: string | null;
  practice_state: string | null;
  practice_zip: string | null;
  practice_phone: string | null;
  practice_fax: string | null;
  mail_city: string | null;
  mail_state: string | null;
  mail_phone: string | null;
  mail_fax: string | null;
  deactivation_date: string | null;
  taxonomies: LocalProviderTaxonomy[] | null;
};

type LocalProviderPage = {
  results: LocalProvider[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};

type LocalSearchParams = {
  search: string;
  state: string;
  entity_type: string; // "" | "1" | "2"
  has_fax: boolean;
};

function fmtPhone(raw: string | null | undefined): string {
  if (!raw) return "—";
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

function LocalProviderRow({ provider, onCopyFax }: { provider: LocalProvider; onCopyFax: (fax: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const fax = provider.practice_fax || provider.mail_fax;
  const isDeactivated = !!provider.deactivation_date;
  const primaryTax = provider.taxonomies?.find((t) => t.primary) ?? provider.taxonomies?.[0];

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="font-mono text-xs">{provider.npi}</TableCell>
        <TableCell className="font-medium">
          <div className="flex items-center gap-1.5">
            {isDeactivated && <Badge variant="destructive" className="text-[10px] px-1 py-0">Deactivated</Badge>}
            <span className={isDeactivated ? "line-through text-muted-foreground" : ""}>
              {provider.display_name || "—"}
            </span>
          </div>
        </TableCell>
        <TableCell>
          {provider.credential ? (
            <Badge variant="secondary" className="text-xs">{provider.credential}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
        <TableCell>
          <span className="text-xs text-muted-foreground">
            {primaryTax?.code || "—"}
          </span>
        </TableCell>
        <TableCell className="text-sm">
          {provider.practice_city || provider.mail_city || "—"}
          {(provider.practice_state || provider.mail_state) && `, ${provider.practice_state || provider.mail_state}`}
        </TableCell>
        <TableCell className="text-sm">{fmtPhone(provider.practice_phone || provider.mail_phone)}</TableCell>
        <TableCell>
          {fax ? (
            <div className="flex items-center gap-1">
              <span className="text-sm font-mono text-xs">{fmtPhone(fax)}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                title="Copy fax"
                onClick={(e) => { e.stopPropagation(); onCopyFax(fax); }}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground inline" /> : <ChevronDown className="h-4 w-4 text-muted-foreground inline" />}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={8} className="p-0 border-b">
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm font-medium mb-1">Practice Address</p>
                    <p className="text-xs text-muted-foreground">
                      {provider.practice_city}, {provider.practice_state} {provider.practice_zip || ""}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Ph: {fmtPhone(provider.practice_phone)}</p>
                    <p className="text-xs text-muted-foreground">Fax: {fmtPhone(provider.practice_fax)}</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <Phone className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm font-medium mb-1">Mailing Address</p>
                    <p className="text-xs text-muted-foreground">
                      {provider.mail_city}, {provider.mail_state}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Ph: {fmtPhone(provider.mail_phone)}</p>
                    <p className="text-xs text-muted-foreground">Fax: {fmtPhone(provider.mail_fax)}</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  {provider.entity_type === "2" ? (
                    <Building className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  ) : (
                    <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium mb-1">Taxonomy Codes</p>
                    {provider.taxonomies && provider.taxonomies.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {provider.taxonomies.map((t, i) => (
                          <Badge key={i} variant={t.primary ? "default" : "outline"} className="text-[10px] font-mono">
                            {t.code}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">None on file</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

const EMPTY_LOCAL_SEARCH: LocalSearchParams = { search: "", state: "", entity_type: "", has_fax: false };

function LocalDbTab() {
  const { toast } = useToast();
  const [form, setForm] = useState<LocalSearchParams>(EMPTY_LOCAL_SEARCH);
  const [activeParams, setActiveParams] = useState<LocalSearchParams | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const queryParams = activeParams
    ? {
        ...(activeParams.search ? { search: activeParams.search } : {}),
        ...(activeParams.state ? { state: activeParams.state } : {}),
        ...(activeParams.entity_type ? { entity_type: activeParams.entity_type } : {}),
        ...(activeParams.has_fax ? { has_fax: "true" } : {}),
        page: String(page),
        page_size: String(PAGE_SIZE),
      }
    : null;

  const { data, isLoading, isError } = useQuery<LocalProviderPage>({
    queryKey: ["npi-providers-local", queryParams],
    queryFn: () => apiFetch<LocalProviderPage>(`/api/npi/providers?${new URLSearchParams(queryParams!).toString()}`),
    enabled: !!queryParams,
    placeholderData: keepPreviousData,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const hasFilter = form.search || form.state || form.entity_type || form.has_fax;
    if (!hasFilter) return;
    setPage(1);
    setActiveParams({ ...form });
  };

  const handleClear = () => {
    setForm(EMPTY_LOCAL_SEARCH);
    setActiveParams(null);
    setPage(1);
  };

  const handleCopyFax = (fax: string) => {
    const digits = fax.replace(/\D/g, "");
    navigator.clipboard.writeText(digits).then(() => {
      toast({ title: "Fax copied", description: digits });
    });
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-4">
      <Card className="border-border/50 shadow-sm">
        <form onSubmit={handleSearch}>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="local_search">Name or Organization</Label>
                <Input
                  id="local_search"
                  placeholder="e.g. Memorial Hospital, Dr. Smith"
                  value={form.search}
                  onChange={(e) => setForm({ ...form, search: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="local_state">State</Label>
                <Select
                  value={form.state || ""}
                  onValueChange={(val) => setForm({ ...form, state: val === "ALL" ? "" : val })}
                >
                  <SelectTrigger id="local_state">
                    <SelectValue placeholder="Any State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Any State</SelectItem>
                    {US_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="local_entity">Type</Label>
                <Select
                  value={form.entity_type || ""}
                  onValueChange={(val) => setForm({ ...form, entity_type: val === "ALL" ? "" : val })}
                >
                  <SelectTrigger id="local_entity">
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Types</SelectItem>
                    <SelectItem value="1">Individual</SelectItem>
                    <SelectItem value="2">Organization</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Checkbox
                id="local_has_fax"
                checked={form.has_fax}
                onCheckedChange={(checked) => setForm({ ...form, has_fax: !!checked })}
              />
              <Label htmlFor="local_has_fax" className="cursor-pointer text-sm font-normal">
                Only show providers with a fax number
              </Label>
            </div>
            <div className="mt-6 flex gap-3">
              <Button type="button" variant="outline" onClick={handleClear} className="w-1/4">
                Clear
              </Button>
              <Button
                type="submit"
                className="w-3/4"
                disabled={isLoading || (!form.search && !form.state && !form.entity_type && !form.has_fax)}
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="h-4 w-4 rounded-full border-2 border-background border-t-transparent animate-spin" />
                    Searching…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Database className="h-4 w-4" />
                    Search Local Database
                  </span>
                )}
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>

      {activeParams && data && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{data.total.toLocaleString()} provider{data.total !== 1 ? "s" : ""} found</span>
          {totalPages > 1 && (
            <span>Page {page} of {totalPages.toLocaleString()}</span>
          )}
        </div>
      )}

      <Card className="border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">NPI</TableHead>
                <TableHead>Name / Organization</TableHead>
                <TableHead className="w-[80px]">Cred</TableHead>
                <TableHead className="w-[130px]">Taxonomy</TableHead>
                <TableHead className="w-[160px]">Location</TableHead>
                <TableHead className="w-[150px]">Phone</TableHead>
                <TableHead className="w-[180px]">Fax</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {!activeParams && !isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Database className="h-8 w-8 opacity-20" />
                      <p>Search the local NPPES database of 9.5M providers.</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))}
              {isError && !isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center text-destructive">
                    Search failed. Please try again.
                  </TableCell>
                </TableRow>
              )}
              {data && data.results.length === 0 && !isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                    No providers found matching your criteria.
                  </TableCell>
                </TableRow>
              )}
              {data && data.results.map((p) => (
                <LocalProviderRow key={p.npi} provider={p} onCopyFax={handleCopyFax} />
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={page === 1 || isLoading}>
            «
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || isLoading}>
            ‹ Prev
          </Button>
          <span className="text-sm text-muted-foreground px-2">
            {page} / {totalPages.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!data?.has_more || isLoading}>
            Next ›
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage(totalPages)} disabled={page === totalPages || isLoading}>
            »
          </Button>
        </div>
      )}
    </div>
  );
}

export default function NpiLookup() {
  const [formValues, setFormValues] = useState<SearchNpiParams>({
    npi_number: "",
    first_name: "",
    last_name: "",
    city: "",
    state: "",
    specialty: "",
    limit: "50"
  });
  
  const [searchParams, setSearchParams] = useState<SearchNpiParams | null>(null);

  const { data, isLoading, isError } = useSearchNpi(searchParams || {}, {
    query: { 
      enabled: !!searchParams,
      queryKey: getSearchNpiQueryKey(searchParams || {})
    }
  });

  // Verify Match panel state — operator-facing rich verification.
  const [verifyForm, setVerifyForm] = useState<VerifyFormState>(EMPTY_VERIFY_FORM);
  const verifyMutation = useVerifyProviderMatch();
  const verifyResult = verifyMutation.data;
  const verifyError = verifyMutation.error as { message?: string } | null;

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    const npi = verifyForm.npi.trim();
    const expected = {
      name: verifyForm.name.trim() || undefined,
      organization: verifyForm.organization.trim() || undefined,
      city: verifyForm.city.trim() || undefined,
      state: verifyForm.state.trim() || undefined,
      specialty: verifyForm.specialty.trim() || undefined,
    };
    const hasAnyExpected = Object.values(expected).some((v) => !!v);
    if (!npi && !hasAnyExpected) return;
    verifyMutation.mutate({
      data: { npi: npi || undefined, expected },
    });
  };

  const handleVerifyClear = () => {
    setVerifyForm(EMPTY_VERIFY_FORM);
    verifyMutation.reset();
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // Clean up empty strings
    const cleanedParams: SearchNpiParams = {};
    Object.entries(formValues).forEach(([key, value]) => {
      if (value && value.trim() !== "") {
        (cleanedParams as any)[key] = value.trim();
      }
    });
    setSearchParams(cleanedParams);
  };

  const handleClear = () => {
    setFormValues({
      npi_number: "",
      first_name: "",
      last_name: "",
      city: "",
      state: "",
      specialty: "",
      limit: "50"
    });
    setSearchParams(null);
  };

  return (
    <div className="flex-1 space-y-6 p-8 pt-6 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold tracking-tight">NPI Provider Lookup</h2>
          <p className="text-muted-foreground">
            Search the national registry for doctors and medical organizations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Stethoscope className="h-8 w-8 text-primary opacity-20" />
        </div>
      </div>

      <Tabs defaultValue="local">
        <TabsList>
          <TabsTrigger value="local" className="gap-2">
            <Database className="h-4 w-4" />
            Local Database
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-2">
            <Search className="h-4 w-4" />
            CMS Registry
          </TabsTrigger>
          <TabsTrigger value="verify" className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Verify Match
          </TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="mt-4">
          <LocalDbTab />
        </TabsContent>

        <TabsContent value="search" className="space-y-4 mt-4">

      <Card className="border-border/50 shadow-sm">
        <form onSubmit={handleSearch}>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="space-y-2">
                <Label htmlFor="npi_number">NPI Number</Label>
                <Input
                  id="npi_number"
                  placeholder="10-digit NPI"
                  value={formValues.npi_number || ""}
                  onChange={(e) => setFormValues({ ...formValues, npi_number: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="first_name">First Name</Label>
                <Input
                  id="first_name"
                  placeholder="e.g. John"
                  value={formValues.first_name || ""}
                  onChange={(e) => setFormValues({ ...formValues, first_name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Last Name</Label>
                <Input
                  id="last_name"
                  placeholder="e.g. Smith"
                  value={formValues.last_name || ""}
                  onChange={(e) => setFormValues({ ...formValues, last_name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  placeholder="e.g. Houston"
                  value={formValues.city || ""}
                  onChange={(e) => setFormValues({ ...formValues, city: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Select
                  value={formValues.state || ""}
                  onValueChange={(val) => setFormValues({ ...formValues, state: val === "ALL" ? "" : val })}
                >
                  <SelectTrigger id="state">
                    <SelectValue placeholder="Any State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Any State</SelectItem>
                    {US_STATES.map((state) => (
                      <SelectItem key={state} value={state}>{state}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="specialty">Specialty (Taxonomy)</Label>
                <Input
                  id="specialty"
                  placeholder="e.g. Oncology, Internal Medicine"
                  value={formValues.specialty || ""}
                  onChange={(e) => setFormValues({ ...formValues, specialty: e.target.value })}
                />
              </div>
            </div>

            <div className="mt-8 flex flex-col items-center gap-3">
              <div className="flex w-full gap-3">
                <Button type="button" variant="outline" onClick={handleClear} className="w-1/4">
                  Clear
                </Button>
                <Button type="submit" className="w-3/4" disabled={isLoading}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full border-2 border-background border-t-transparent animate-spin" />
                      Searching...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Search className="h-4 w-4" />
                      Search Providers
                    </span>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Powered by CMS NPI Registry (npiregistry.cms.hhs.gov)
              </p>
            </div>
          </CardContent>
        </form>
      </Card>

      <div className="space-y-4">
        {searchParams && data && (
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">
              {data.result_count} provider{data.result_count !== 1 ? 's' : ''} found
            </h3>
            {data.result_count >= 50 && (
              <span className="text-xs text-amber-500/80 bg-amber-500/10 px-2 py-1 rounded">
                Showing top 50 results. Refine search for more specific matches.
              </span>
            )}
          </div>
        )}

        <Card className="border-border/50 overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">NPI</TableHead>
                  <TableHead>Provider Name</TableHead>
                  <TableHead className="w-[100px]">Cred</TableHead>
                  <TableHead className="w-[200px]">Specialty</TableHead>
                  <TableHead className="w-[150px]">Location</TableHead>
                  <TableHead className="w-[150px]">Phone</TableHead>
                  <TableHead className="text-right w-[150px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!searchParams && !isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Search className="h-8 w-8 opacity-20" />
                        <p>Enter search criteria above to find providers.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                
                {isLoading && (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-10 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    </TableRow>
                  ))
                )}

                {isError && !isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-destructive">
                      An error occurred while fetching data from the NPI Registry. Please try again.
                    </TableCell>
                  </TableRow>
                )}

                {data && data.results.length === 0 && !isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      No providers found matching your search criteria.
                    </TableCell>
                  </TableRow>
                )}

                {data && data.results.map((provider) => (
                  <ProviderRow key={provider.npi} provider={provider} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
        </TabsContent>

        <TabsContent value="verify" className="space-y-4 mt-4">
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Verify Provider Match
              </CardTitle>
              <CardDescription>
                Check whether a claimed provider profile (from intake, a referral, or a lead) actually matches the
                CMS NPI Registry. Provide an NPI for a direct lookup, or leave it blank to fuzzy-search by name +
                city + state.
              </CardDescription>
            </CardHeader>
            <form onSubmit={handleVerify}>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="verify_npi">NPI (optional)</Label>
                    <Input
                      id="verify_npi"
                      placeholder="10-digit NPI"
                      value={verifyForm.npi}
                      onChange={(e) => setVerifyForm({ ...verifyForm, npi: e.target.value })}
                      className="font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      If supplied, lookup is direct; otherwise we search by the fields below.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="verify_name">Provider Name</Label>
                    <Input
                      id="verify_name"
                      placeholder="e.g. Ardalan Enkeshafi"
                      value={verifyForm.name}
                      onChange={(e) => setVerifyForm({ ...verifyForm, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="verify_organization">Organization</Label>
                    <Input
                      id="verify_organization"
                      placeholder="(optional, for org-type NPIs)"
                      value={verifyForm.organization}
                      onChange={(e) => setVerifyForm({ ...verifyForm, organization: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="verify_city">City</Label>
                    <Input
                      id="verify_city"
                      placeholder="e.g. Bethesda"
                      value={verifyForm.city}
                      onChange={(e) => setVerifyForm({ ...verifyForm, city: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="verify_state">State</Label>
                    <Select
                      value={verifyForm.state || ""}
                      onValueChange={(val) =>
                        setVerifyForm({ ...verifyForm, state: val === "ALL" ? "" : val })
                      }
                    >
                      <SelectTrigger id="verify_state">
                        <SelectValue placeholder="Any State" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">Any State</SelectItem>
                        {US_STATES.map((state) => (
                          <SelectItem key={state} value={state}>
                            {state}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="verify_specialty">Specialty</Label>
                    <Input
                      id="verify_specialty"
                      placeholder="e.g. Hospitalist, Oncology"
                      value={verifyForm.specialty}
                      onChange={(e) => setVerifyForm({ ...verifyForm, specialty: e.target.value })}
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleVerifyClear}
                    className="w-1/4"
                  >
                    Clear
                  </Button>
                  <Button
                    type="submit"
                    className="w-3/4"
                    disabled={verifyMutation.isPending}
                  >
                    {verifyMutation.isPending ? (
                      <span className="flex items-center gap-2">
                        <div className="h-4 w-4 rounded-full border-2 border-background border-t-transparent animate-spin" />
                        Verifying...
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" />
                        Verify Match
                      </span>
                    )}
                  </Button>
                </div>
              </CardContent>
            </form>
          </Card>

          {verifyError && !verifyMutation.isPending && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="pt-6 text-sm text-destructive">
                {verifyError.message ?? "Verification failed. Please try again."}
              </CardContent>
            </Card>
          )}

          {verifyResult && !verifyMutation.isPending && (
            <VerifyResultPanel result={verifyResult} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
