import { useParams, Link } from "wouter";
import { useGetLead, getGetLeadQueryKey, useUpdateLead, useDeleteLead, useListDocuments, getListDocumentsQueryKey, useQualifyLead, UpdateLeadBodyStatus } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { ArrowLeft, Trash2, FileText, CheckCircle, XCircle, FileSignature, AlertTriangle, Download } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const leadId = parseInt(id, 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: lead, isLoading } = useGetLead(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadQueryKey(leadId) }
  });

  const { data: documents, isLoading: docsLoading } = useListDocuments({ lead_id: leadId }, {
    query: { enabled: !!leadId, queryKey: getListDocumentsQueryKey({ lead_id: leadId }) }
  });

  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();
  const qualifyLead = useQualifyLead();

  const handleStatusChange = async (newStatus: UpdateLeadBodyStatus) => {
    try {
      await updateLead.mutateAsync({ id: leadId, data: { status: newStatus } });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      toast({ title: "Status updated" });
    } catch (err) {
      toast({ title: "Error updating status", variant: "destructive" });
    }
  };

  const handleRunGatekeeper = async () => {
    try {
      const res = await qualifyLead.mutateAsync({ id: leadId });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      toast({ 
        title: "Gatekeeper Run", 
        description: `Result: ${res.status.toUpperCase()}`,
        variant: res.status === "rejected" ? "destructive" : "default"
      });
    } catch (err) {
      toast({ title: "Gatekeeper failed", variant: "destructive" });
    }
  };

  if (isLoading || !lead) {
    return <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-[400px] w-full" />
    </div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" asChild>
            <Link href="/leads"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{lead.name}</h1>
            <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
              <span className="font-mono">ID: {lead.id}</span>
              <span>•</span>
              <span>{lead.tort_type}</span>
              <span>•</span>
              <span>Created {format(new Date(lead.created_at), "MMM d, yyyy")}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lead.status === "new" && (
            <Button onClick={handleRunGatekeeper} disabled={qualifyLead.isPending}>
              Run Gatekeeper
            </Button>
          )}
          {lead.status === "qualified" && (
            <Button onClick={() => handleStatusChange("signed")} className="bg-green-600 hover:bg-green-700">
              <FileSignature className="mr-2 h-4 w-4" />
              Mark as Signed
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.open(`/api/leads/export?lead_id=${lead.id}`, "_blank");
            }}
          >
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Badge variant={
            lead.status === "signed" ? "default" :
            lead.status === "qualified" ? "secondary" :
            lead.status === "rejected" ? "destructive" :
            lead.status === "review_required" ? "secondary" : "outline"
          } className={`text-sm px-3 py-1 ${lead.status === "review_required" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}`}>
            {lead.status === "review_required" ? "REVIEW REQUIRED" : lead.status.toUpperCase()}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Email</div>
                <div>{lead.email || "—"}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Phone</div>
                <div>{lead.phone || "—"}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Source</div>
                <div>{lead.source || "—"}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Ad Spend</div>
                <div>{lead.ad_spend ? `$${lead.ad_spend.toFixed(2)}` : "—"}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Law Firm</div>
                <div>{lead.law_firm || "—"}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">Client ID</div>
                <div>{lead.client_id || "—"}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Qualification Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 border p-3 rounded-md">
                {lead.diagnosis_confirmed ? <CheckCircle className="text-green-500 h-5 w-5" /> : <XCircle className="text-red-500 h-5 w-5" />}
                <div>
                  <div className="font-medium">Medical Diagnosis</div>
                  <div className="text-sm text-muted-foreground">{lead.diagnosis_type || "Not specified"}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 border p-3 rounded-md">
                {lead.was_at_location ? <CheckCircle className="text-green-500 h-5 w-5" /> : <XCircle className="text-red-500 h-5 w-5" />}
                <div>
                  <div className="font-medium">Location Exposure</div>
                  <div className="text-sm text-muted-foreground">{lead.location_name || "Not specified"}</div>
                </div>
              </div>
              {lead.rejection_reason && (
                <div className="bg-destructive/10 text-destructive p-3 rounded-md text-sm border border-destructive/20 mt-4">
                  <span className="font-bold">Rejection Reason:</span> {lead.rejection_reason}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Compliance & Verification</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center gap-3 border p-3 rounded-md">
                {lead.npi_verified ? <CheckCircle className="text-green-500 h-5 w-5 shrink-0" /> : <XCircle className="text-red-500 h-5 w-5 shrink-0" />}
                <div>
                  <div className="font-medium">NPI Verification</div>
                  <div className="text-sm text-muted-foreground">
                    {lead.npi_verified ? `Verified (${lead.npi_number || "N/A"})` : "Not verified"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 border p-3 rounded-md">
                {lead.tcpa_consent ? <CheckCircle className="text-green-500 h-5 w-5 shrink-0" /> : <XCircle className="text-red-500 h-5 w-5 shrink-0" />}
                <div>
                  <div className="font-medium">TCPA Consent</div>
                  <div className="text-sm text-muted-foreground">{lead.tcpa_consent ? "Granted" : "Missing"}</div>
                </div>
              </div>
              {lead.physician_taxonomy && (
                <div className="border p-3 rounded-md">
                  <div className="font-medium">Physician Taxonomy</div>
                  <div className="text-sm text-muted-foreground">{lead.physician_taxonomy}</div>
                </div>
              )}
              {lead.fraud_status && (
                <div className="border p-3 rounded-md">
                  <div className="font-medium">Arbiter Decision</div>
                  <div className="text-sm">
                    <Badge variant={
                      lead.fraud_status === "ACCEPTED" ? "default" :
                      lead.fraud_status === "REJECTED" ? "destructive" : "secondary"
                    } className={lead.fraud_status === "ACCEPTED" ? "bg-green-500/10 text-green-600 border-green-500/20" : lead.fraud_status === "TO_BE_REVIEWED" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}>
                      {lead.fraud_status}
                    </Badge>
                  </div>
                </div>
              )}
              {typeof lead.fraud_score === "number" && lead.fraud_score > 0 && (
                <div className="border p-3 rounded-md">
                  <div className="font-medium">Fraud Score</div>
                  <div className={`text-sm font-mono ${lead.fraud_score >= 60 ? "text-red-500" : lead.fraud_score >= 20 ? "text-amber-500" : "text-green-500"}`}>
                    {lead.fraud_score}/100
                  </div>
                </div>
              )}
              {lead.background_check_status && (
                <div className="flex items-center gap-3 border p-3 rounded-md">
                  {lead.background_check_status === "clean" ? <CheckCircle className="text-green-500 h-5 w-5 shrink-0" /> : <AlertTriangle className="text-amber-500 h-5 w-5 shrink-0" />}
                  <div>
                    <div className="font-medium">Background Check</div>
                    <div className="text-sm text-muted-foreground">{lead.background_check_status.charAt(0).toUpperCase() + lead.background_check_status.slice(1)}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {lead.background_check_data && (() => {
            try {
              const bgData = JSON.parse(lead.background_check_data as string) as {
                summary?: string;
                checked_at?: string;
                records?: Array<{
                  type: string;
                  description: string;
                  date?: string;
                  jurisdiction?: string;
                  severity: string;
                  role?: string;
                }>;
              };
              if (!bgData.records || bgData.records.length === 0) return null;
              const partyRecords = bgData.records.filter(r => r.role === "party");
              const mentionRecords = bgData.records.filter(r => r.role === "mentioned");
              return (
                <Card>
                  <CardHeader>
                    <CardTitle>Court Records</CardTitle>
                    <CardDescription>
                      {bgData.summary}
                      {bgData.checked_at && ` — checked ${format(new Date(bgData.checked_at), "MMM d, yyyy")}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {partyRecords.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-sm font-semibold text-red-600">Cases as Party ({partyRecords.length})</div>
                        {partyRecords.map((rec, i) => (
                          <div key={`party-${i}`} className="border border-red-200 bg-red-50 rounded-md p-3 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-sm">{rec.description}</span>
                              <Badge variant="destructive" className="text-xs">
                                {rec.severity === "high" ? "High" : "Medium"}
                              </Badge>
                            </div>
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              {rec.date && <span>Filed: {format(new Date(rec.date), "MMM d, yyyy")}</span>}
                              {rec.jurisdiction && <span>{rec.jurisdiction}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {mentionRecords.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-sm font-semibold text-muted-foreground">Mentions in Other Cases ({mentionRecords.length})</div>
                        {mentionRecords.map((rec, i) => (
                          <div key={`mention-${i}`} className="border rounded-md p-3 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-sm">{rec.description}</span>
                              <Badge variant="outline" className="text-xs">Low</Badge>
                            </div>
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              {rec.date && <span>Filed: {format(new Date(rec.date), "MMM d, yyyy")}</span>}
                              {rec.jurisdiction && <span>{rec.jurisdiction}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            } catch { return null; }
          })()}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>Documents</CardTitle>
              <Button variant="ghost" size="icon"><FileText className="h-4 w-4" /></Button>
            </CardHeader>
            <CardContent>
              {docsLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : documents?.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No documents attached.</p>
              ) : (
                <div className="space-y-3">
                  {documents?.map(doc => (
                    <div key={doc.id} className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0">
                      <div className="text-sm">
                        <div className="font-medium truncate max-w-[150px]">{doc.file_name}</div>
                        <div className="text-xs text-muted-foreground">{doc.document_type}</div>
                      </div>
                      {doc.signed ? (
                        <Badge variant="secondary" className="bg-green-500/20 text-green-500 hover:bg-green-500/20">Signed</Badge>
                      ) : (
                        <Badge variant="outline">Pending</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Danger Zone</CardTitle>
            </CardHeader>
            <CardContent>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="destructive" className="w-full">Delete Lead</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Are you absolutely sure?</DialogTitle>
                    <DialogDescription>
                      This action cannot be undone. This will permanently delete the lead
                      and remove their data from our servers.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button variant="destructive" onClick={async () => {
                      try {
                        await deleteLead.mutateAsync({ id: leadId });
                        toast({ title: "Lead deleted" });
                        window.location.href = "/leads";
                      } catch (e) {
                        toast({ title: "Delete failed", variant: "destructive" });
                      }
                    }} disabled={deleteLead.isPending}>
                      {deleteLead.isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
