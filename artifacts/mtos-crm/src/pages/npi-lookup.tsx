import { useState } from "react";
import { Link } from "wouter";
import { useSearchNpi, getSearchNpiQueryKey, SearchNpiParams, NpiProvider } from "@workspace/api-client-react";
import { Search, Stethoscope, ChevronDown, ChevronUp, MapPin, Phone, Building, User, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

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
    </div>
  );
}
