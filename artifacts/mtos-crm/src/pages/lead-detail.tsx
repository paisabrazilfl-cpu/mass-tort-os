import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { useGetLead, getGetLeadQueryKey, useUpdateLead, useDeleteLead, useListDocuments, getListDocumentsQueryKey, useQualifyLead, useGetFormConfigs, UpdateLeadBodyStatus } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { format } from "date-fns";
import {
  ArrowLeft, Trash2, FileText, CheckCircle, XCircle, FileSignature,
  AlertTriangle, Download, Brain, Save, RefreshCw, Shield, User,
  MapPin, Phone, Mail, Building2, Stethoscope, Scale, Activity
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface IntelligenceScore {
  completion_score: number;
  completion_grade: string;
  completion_details: string[];
  reliability_score: number;
  reliability_grade: string;
  reliability_details: string[];
  truthfulness_score: number;
  truthfulness_grade: string;
  truthfulness_details: string[];
  overall_assessment: string;
  recommended_action: string;
  scored_at: string;
}

interface LensScore {
  conversion_probability: number;
  risk_score: number;
  quality_tier: string;
  factors: Record<string, number>;
}

function FieldRow({ label, value, sensitive }: { label: string; value: any; sensitive?: boolean }) {
  const displayVal = value === null || value === undefined || value === "" ? null : String(value);
  return (
    <div className="flex flex-col py-2 border-b border-gray-100 last:border-0">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className={`text-sm mt-0.5 ${displayVal ? "text-foreground" : "text-muted-foreground italic"} ${sensitive ? "font-mono" : ""}`}>
        {displayVal || "Not provided"}
      </span>
    </div>
  );
}

function ScoreBadge({ score, label, grade }: { score: number; label: string; grade: string }) {
  const color = score >= 75 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-red-600";
  const bg = score >= 75 ? "bg-emerald-50 border-emerald-200" : score >= 50 ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200";
  const barColor = score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`rounded-lg border p-3 ${bg}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <span className={`text-lg font-bold ${color}`}>{score}</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-[10px] font-medium ${color}`}>{grade}</span>
    </div>
  );
}

function ScoreGauge({ score, label, grade }: { score: number; label: string; grade: string }) {
  const color = score >= 75 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-red-600";
  const bg = score >= 75 ? "bg-emerald-50 border-emerald-200" : score >= 50 ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200";
  const barColor = score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";

  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{label}</span>
        <span className={`text-2xl font-bold ${color}`}>{score}</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
        <div className={`h-2 rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-xs font-medium ${color}`}>{grade}</span>
    </div>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const leadId = parseInt(id, 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [notes, setNotes] = useState<string | null>(null);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [intelligence, setIntelligence] = useState<IntelligenceScore | null>(null);
  const [scoringInProgress, setScoringInProgress] = useState(false);
  const [scoringError, setScoringError] = useState<string | null>(null);
  const [lensScore, setLensScore] = useState<LensScore | null>(null);
  const [lensLoading, setLensLoading] = useState(false);
  const autoTriggered = useRef(false);

  const { data: lead, isLoading } = useGetLead(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadQueryKey(leadId) }
  });

  const { data: documents, isLoading: docsLoading } = useListDocuments({ lead_id: leadId }, {
    query: { enabled: !!leadId, queryKey: getListDocumentsQueryKey({ lead_id: leadId }) }
  });

  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();
  const qualifyLead = useQualifyLead();

  if (lead && !notesLoaded) {
    setNotes(lead.notes || "");
    setNotesLoaded(true);
  }

  const handleStatusChange = async (newStatus: UpdateLeadBodyStatus) => {
    try {
      await updateLead.mutateAsync({ id: leadId, data: { status: newStatus } });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      toast({ title: "Status updated successfully" });
    } catch {
      toast({ title: "Unable to update status — please retry", variant: "destructive" });
    }
  };

  const handleRunGatekeeper = async () => {
    try {
      const res = await qualifyLead.mutateAsync({ id: leadId });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      toast({
        title: "Boolean Gatekeeper Complete",
        description: `Determination: ${res.status.toUpperCase()}`,
        variant: res.status === "rejected" ? "destructive" : "default"
      });
    } catch {
      toast({ title: "Gatekeeper evaluation failed — please retry", variant: "destructive" });
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || "" }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast({ title: "Case notes saved" });
    } catch {
      toast({ title: "Unable to save notes — please retry", variant: "destructive" });
    } finally {
      setSavingNotes(false);
    }
  };

  const handleRunIntelligence = useCallback(async () => {
    setScoringInProgress(true);
    setScoringError(null);

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`/api/leads/${leadId}/intelligence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Scoring returned status ${res.status}`);
        }
        const data = await res.json();
        setIntelligence(data);
        setScoringInProgress(false);
        return;
      } catch (err: any) {
        if (attempt === maxRetries) {
          setScoringError(err.message || "Intelligence scoring unavailable after multiple attempts");
          setScoringInProgress(false);
        } else {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }, [leadId]);

  const fetchLensScore = useCallback(async () => {
    setLensLoading(true);
    try {
      const res = await fetch(`/api/analytics/predictive/lead/${leadId}`);
      if (res.ok) {
        setLensScore(await res.json());
      }
    } catch {
    } finally {
      setLensLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    if (lead && !autoTriggered.current) {
      autoTriggered.current = true;
      handleRunIntelligence();
      fetchLensScore();
    }
  }, [lead, handleRunIntelligence, fetchLensScore]);

  if (isLoading || !lead) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
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
              <span>·</span>
              <span>{lead.tort_type}</span>
              <span>·</span>
              <span>Intake {format(new Date(lead.created_at), "MMM d, yyyy")}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lead.status === "new" && (
            <Button onClick={handleRunGatekeeper} disabled={qualifyLead.isPending}>
              <Scale className="mr-2 h-4 w-4" />
              Run Gatekeeper
            </Button>
          )}
          {lead.status === "qualified" && (
            <Button onClick={() => handleStatusChange("signed")} className="bg-emerald-600 hover:bg-emerald-700">
              <FileSignature className="mr-2 h-4 w-4" />
              Execute Retainer
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/leads/export?lead_id=${lead.id}`, "_blank")}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Badge variant={
            lead.status === "signed" ? "default" :
            lead.status === "qualified" ? "secondary" :
            lead.status === "rejected" ? "destructive" :
            lead.status === "review_required" ? "secondary" : "outline"
          } className={`text-sm px-3 py-1 ${lead.status === "review_required" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : lead.status === "signed" ? "bg-emerald-600" : ""}`}>
            {lead.status === "review_required" ? "REVIEW REQUIRED" : lead.status.toUpperCase()}
          </Badge>
        </div>
      </div>

      {lead.rejection_reason && (
        <div className="bg-destructive/10 text-destructive p-4 rounded-lg text-sm border border-destructive/20 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Disposition Note:</span> {lead.rejection_reason}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-5">
        {scoringInProgress ? (
          <>
            {[1,2,3].map(i => <Skeleton key={i} className="h-[72px] rounded-lg" />)}
            <Skeleton className="h-[72px] rounded-lg" />
            <Skeleton className="h-[72px] rounded-lg" />
          </>
        ) : intelligence ? (
          <>
            <ScoreBadge label="Completion" score={intelligence.completion_score} grade={intelligence.completion_grade} />
            <ScoreBadge label="Reliability" score={intelligence.reliability_score} grade={intelligence.reliability_grade} />
            <ScoreBadge label="Truthfulness" score={intelligence.truthfulness_score} grade={intelligence.truthfulness_grade} />
          </>
        ) : scoringError ? (
          <div className="md:col-span-3 flex items-center gap-2 text-sm text-muted-foreground bg-gray-50 rounded-lg border p-3">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span>Intelligence scoring unavailable</span>
            <Button variant="ghost" size="sm" onClick={handleRunIntelligence} className="ml-auto text-xs">Retry</Button>
          </div>
        ) : (
          <div className="md:col-span-3" />
        )}
        {lensLoading ? (
          <>
            <Skeleton className="h-[72px] rounded-lg" />
            <Skeleton className="h-[72px] rounded-lg" />
          </>
        ) : lensScore ? (
          <>
            <div className="rounded-lg border bg-slate-50 p-3 flex flex-col justify-center">
              <span className="text-xs text-muted-foreground font-medium">Conversion</span>
              <span className="text-xl font-bold text-slate-800">{Math.round(lensScore.conversion_probability)}%</span>
            </div>
            <div className={`rounded-lg border p-3 flex flex-col justify-center ${
              lensScore.quality_tier === "platinum" ? "bg-violet-50 border-violet-200" :
              lensScore.quality_tier === "gold" ? "bg-amber-50 border-amber-200" :
              lensScore.quality_tier === "silver" ? "bg-gray-50 border-gray-300" :
              "bg-orange-50 border-orange-200"
            }`}>
              <span className="text-xs text-muted-foreground font-medium">Quality Tier</span>
              <span className={`text-xl font-bold capitalize ${
                lensScore.quality_tier === "platinum" ? "text-violet-700" :
                lensScore.quality_tier === "gold" ? "text-amber-700" :
                lensScore.quality_tier === "silver" ? "text-gray-600" :
                "text-orange-700"
              }`}>{lensScore.quality_tier}</span>
            </div>
          </>
        ) : (
          <div className="md:col-span-2" />
        )}
      </div>

      {intelligence?.overall_assessment && (
        <div className="bg-slate-50 border rounded-lg p-4 flex items-start gap-3">
          <Brain className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm leading-relaxed">{intelligence.overall_assessment}</p>
            <p className="text-xs text-muted-foreground"><span className="font-medium">Recommended:</span> {intelligence.recommended_action}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRunIntelligence} className="shrink-0 ml-auto text-xs" disabled={scoringInProgress}>
            <RefreshCw className={`h-3 w-3 mr-1 ${scoringInProgress ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      )}

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="profile" className="flex items-center gap-2"><User className="h-4 w-4" />Claimant Profile</TabsTrigger>
          <TabsTrigger value="medical" className="flex items-center gap-2"><Stethoscope className="h-4 w-4" />Medical & Exposure</TabsTrigger>
          <TabsTrigger value="compliance" className="flex items-center gap-2"><Shield className="h-4 w-4" />Compliance</TabsTrigger>
          <TabsTrigger value="documents" className="flex items-center gap-2"><FileText className="h-4 w-4" />Documents</TabsTrigger>
          <TabsTrigger value="intelligence" className="flex items-center gap-2"><Brain className="h-4 w-4" />AI Intelligence</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6 mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><User className="h-4 w-4" />Personal Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="First Name" value={lead.first_name} />
                <FieldRow label="Last Name" value={lead.last_name} />
                <FieldRow label="Date of Birth" value={lead.date_of_birth} sensitive />
                <FieldRow label="Last 4 SSN" value={lead.last_4_ssn} sensitive />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Phone className="h-4 w-4" />Contact Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Primary Phone" value={lead.phone_primary || lead.phone} />
                <FieldRow label="Email Address" value={lead.email} />
                <FieldRow label="Lead Source" value={lead.source} />
                <FieldRow label="Acquisition Cost" value={lead.ad_spend ? `$${Number(lead.ad_spend).toFixed(2)}` : null} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" />Residential Address</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Street Address" value={lead.street_address} />
                <FieldRow label="City" value={lead.city} />
                <FieldRow label="State" value={lead.state} />
                <FieldRow label="ZIP Code" value={lead.zip} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" />Firm & Vendor Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Referring Law Firm" value={lead.law_firm} />
                <FieldRow label="Client Identifier" value={lead.client_id} />
                <FieldRow label="Vendor ID" value={lead.vendor_id} />
                <FieldRow label="Pipeline Routing" value={lead.routing} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Case Notes</CardTitle>
                <CardDescription>Internal memoranda and observations regarding this claimant</CardDescription>
              </div>
              <Button onClick={handleSaveNotes} disabled={savingNotes} size="sm" className="flex items-center gap-2">
                <Save className="h-4 w-4" />
                {savingNotes ? "Saving..." : "Save Notes"}
              </Button>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Enter case notes, observations, follow-up items, or internal memoranda..."
                className="min-h-[160px] resize-y"
                value={notes || ""}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="text-xs text-muted-foreground mt-2">
                Last modified: {lead.updated_at ? format(new Date(lead.updated_at), "MMM d, yyyy 'at' h:mm a") : "—"}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="medical" className="space-y-6 mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" />Tort & Diagnosis</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Tort Classification" value={lead.tort_type} />
                <FieldRow label="Primary Diagnosis" value={lead.diagnosis} />
                <FieldRow label="Diagnosis Date" value={lead.diagnosis_date} />
                <FieldRow label="Diagnosis Type" value={lead.diagnosis_type} />
                <FieldRow label="Current Medications" value={lead.medications} />
                <div className="flex items-center gap-3 py-3 border-b border-gray-100">
                  {lead.diagnosis_confirmed ? <CheckCircle className="text-emerald-500 h-4 w-4" /> : <XCircle className="text-red-500 h-4 w-4" />}
                  <span className="text-sm">{lead.diagnosis_confirmed ? "Diagnosis confirmed by claimant" : "Diagnosis not confirmed"}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" />Exposure Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Exposure Location" value={lead.location_name} />
                <FieldRow label="Exposure Start" value={lead.exposure_start} />
                <FieldRow label="Exposure End" value={lead.exposure_end} />
                <div className="flex items-center gap-3 py-3 border-b border-gray-100">
                  {lead.was_at_location ? <CheckCircle className="text-emerald-500 h-4 w-4" /> : <XCircle className="text-red-500 h-4 w-4" />}
                  <span className="text-sm">{lead.was_at_location ? "Location exposure verified" : "Location exposure not verified"}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Stethoscope className="h-4 w-4" />Treating Physician</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="First Name" value={lead.physician_first_name} />
                <FieldRow label="Last Name" value={lead.physician_last_name} />
                <FieldRow label="Full Address" value={lead.physician_full_address} />
                <FieldRow label="Contact Information" value={lead.physician_contact_info} />
                <FieldRow label="NPI Number" value={lead.npi_number} />
                <FieldRow label="Taxonomy Code" value={lead.physician_taxonomy} />
                <div className="flex items-center gap-3 py-3">
                  {lead.npi_verified ? <CheckCircle className="text-emerald-500 h-4 w-4" /> : <XCircle className="text-red-500 h-4 w-4" />}
                  <span className="text-sm">{lead.npi_verified ? "NPI verified via NPPES registry" : "NPI not yet verified"}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" />Hospital / Treatment Facility</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0">
                <FieldRow label="Facility Name" value={lead.hospital_name} />
                <FieldRow label="Fax Number" value={lead.hospital_fax} />
                <FieldRow label="Contact Information" value={lead.hospital_contact_info} />
              </CardContent>
            </Card>

            <CustomFieldsCard tortType={lead.tort_type} customFields={(lead as any).custom_fields} />
          </div>
        </TabsContent>

        <TabsContent value="compliance" className="space-y-6 mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Consent & Certification</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3 py-2 border-b border-gray-100">
                  {lead.tcpa_consent ? <CheckCircle className="text-emerald-500 h-5 w-5" /> : <XCircle className="text-red-500 h-5 w-5" />}
                  <div>
                    <div className="font-medium text-sm">TCPA Consent</div>
                    <div className="text-xs text-muted-foreground">{lead.tcpa_consent ? "Express written consent obtained" : "Consent not on file"}</div>
                  </div>
                </div>
                <FieldRow label="TrustedForm Certificate URL" value={lead.trustedform_cert_url} />
                <FieldRow label="TrustedForm IP" value={lead.trustedform_ip} />
                <FieldRow label="TrustedForm User Agent" value={lead.trustedform_user_agent} />
                <FieldRow label="TrustedForm Timestamp" value={lead.trustedform_timestamp ? format(new Date(lead.trustedform_timestamp), "MMM d, yyyy h:mm a") : null} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Verification Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3 py-2 border-b border-gray-100">
                  {lead.email_validation_status === "valid" ? <CheckCircle className="text-emerald-500 h-5 w-5" /> :
                   lead.email_validation_status === "invalid" ? <XCircle className="text-red-500 h-5 w-5" /> :
                   <AlertTriangle className="text-amber-500 h-5 w-5" />}
                  <div>
                    <div className="font-medium text-sm">Email Validation</div>
                    <div className="text-xs text-muted-foreground">{lead.email_validation_status ? lead.email_validation_status.charAt(0).toUpperCase() + lead.email_validation_status.slice(1) : "Not performed"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 py-2 border-b border-gray-100">
                  {lead.address_validation_status === "valid" ? <CheckCircle className="text-emerald-500 h-5 w-5" /> :
                   lead.address_validation_status === "invalid" ? <XCircle className="text-red-500 h-5 w-5" /> :
                   <AlertTriangle className="text-amber-500 h-5 w-5" />}
                  <div>
                    <div className="font-medium text-sm">Address Validation</div>
                    <div className="text-xs text-muted-foreground">{lead.address_validation_status ? lead.address_validation_status.charAt(0).toUpperCase() + lead.address_validation_status.slice(1) : "Not performed"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 py-2 border-b border-gray-100">
                  {lead.background_check_status === "clean" ? <CheckCircle className="text-emerald-500 h-5 w-5" /> :
                   lead.background_check_status === "flagged" ? <AlertTriangle className="text-amber-500 h-5 w-5" /> :
                   <XCircle className="text-muted-foreground h-5 w-5" />}
                  <div>
                    <div className="font-medium text-sm">Background Check</div>
                    <div className="text-xs text-muted-foreground">{lead.background_check_status ? lead.background_check_status.charAt(0).toUpperCase() + lead.background_check_status.slice(1) : "Not initiated"}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Fraud Assessment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {lead.fraud_status && (
                  <div className="flex items-center justify-between py-2 border-b border-gray-100">
                    <span className="text-sm font-medium">Final Arbiter Decision</span>
                    <Badge variant={
                      lead.fraud_status === "ACCEPTED" ? "default" :
                      lead.fraud_status === "REJECTED" ? "destructive" : "secondary"
                    } className={lead.fraud_status === "ACCEPTED" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" : lead.fraud_status === "TO_BE_REVIEWED" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}>
                      {lead.fraud_status}
                    </Badge>
                  </div>
                )}
                {typeof lead.fraud_score === "number" && (
                  <div className="flex items-center justify-between py-2 border-b border-gray-100">
                    <span className="text-sm font-medium">Fraud Risk Score</span>
                    <span className={`text-lg font-bold font-mono ${lead.fraud_score >= 60 ? "text-red-600" : lead.fraud_score >= 20 ? "text-amber-600" : "text-emerald-600"}`}>
                      {lead.fraud_score}/100
                    </span>
                  </div>
                )}
                {lead.fraud_indicators && (
                  <div className="py-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Indicators</span>
                    <p className="text-sm mt-1">{lead.fraud_indicators}</p>
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
                          <div className="text-sm font-semibold text-red-600">Named Party ({partyRecords.length})</div>
                          {partyRecords.map((rec, i) => (
                            <div key={`party-${i}`} className="border border-red-200 bg-red-50 rounded-md p-3 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-sm">{rec.description}</span>
                                <Badge variant="destructive" className="text-xs">{rec.severity === "high" ? "High" : "Medium"}</Badge>
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
                          <div className="text-sm font-semibold text-muted-foreground">Referenced Mentions ({mentionRecords.length})</div>
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
        </TabsContent>

        <TabsContent value="documents" className="space-y-6 mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Associated Documents</CardTitle>
                <CardDescription>All documents, agreements, and records linked to this claimant</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {docsLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !documents || documents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No documents have been associated with this claimant record.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {documents.map(doc => (
                    <div key={doc.id} className="flex items-center justify-between py-3 border-b last:border-0">
                      <div className="flex items-center gap-3">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium text-sm">{doc.file_name}</div>
                          <div className="text-xs text-muted-foreground">{doc.document_type} · ID: {doc.id}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {doc.signed ? (
                          <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Executed</Badge>
                        ) : (
                          <Badge variant="outline">Pending Execution</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="intelligence" className="space-y-6 mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2"><Brain className="h-5 w-5" />Lead Intelligence Assessment</CardTitle>
                <CardDescription>AI-powered analysis evaluating file completeness, data reliability, and claim veracity</CardDescription>
              </div>
              <Button onClick={handleRunIntelligence} disabled={scoringInProgress} variant="outline" size="sm" className="flex items-center gap-2">
                {scoringInProgress ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {scoringInProgress ? "Re-analyzing..." : "Refresh Scores"}
              </Button>
            </CardHeader>
            <CardContent>
              {!intelligence && !scoringInProgress && !scoringError && (
                <div className="text-center py-12 text-muted-foreground">
                  <Brain className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">Intelligence assessment is initializing...</p>
                </div>
              )}

              {scoringError && (
                <div className="bg-destructive/10 text-destructive p-4 rounded-lg text-sm border border-destructive/20 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Assessment Unavailable:</span> {scoringError}
                    <div className="mt-2">
                      <Button variant="outline" size="sm" onClick={handleRunIntelligence}>Retry Assessment</Button>
                    </div>
                  </div>
                </div>
              )}

              {scoringInProgress && (
                <div className="text-center py-12">
                  <RefreshCw className="h-8 w-8 mx-auto mb-3 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Evaluating claimant record across all available parameters...</p>
                </div>
              )}

              {intelligence && !scoringInProgress && (
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    <ScoreGauge score={intelligence.completion_score} label="Completion Score" grade={intelligence.completion_grade} />
                    <ScoreGauge score={intelligence.reliability_score} label="Reliability Score" grade={intelligence.reliability_grade} />
                    <ScoreGauge score={intelligence.truthfulness_score} label="Truthfulness Score" grade={intelligence.truthfulness_grade} />
                  </div>

                  <Separator />

                  <div className="bg-slate-50 border rounded-lg p-4 space-y-3">
                    <h4 className="font-semibold text-sm">Overall Assessment</h4>
                    <p className="text-sm leading-relaxed">{intelligence.overall_assessment}</p>
                    <div className="bg-white border rounded-md p-3 mt-2">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recommended Action</span>
                      <p className="text-sm mt-1 font-medium">{intelligence.recommended_action}</p>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Scored: {format(new Date(intelligence.scored_at), "MMM d, yyyy 'at' h:mm a")}
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Completion Findings</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1.5">
                          {intelligence.completion_details.map((d, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <span className={d.startsWith("Missing") ? "text-red-400" : "text-emerald-400"}>·</span>
                              {d}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Reliability Findings</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1.5">
                          {intelligence.reliability_details.map((d, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <span className={d.includes("not") || d.includes("failed") || d.includes("No ") ? "text-red-400" : "text-emerald-400"}>·</span>
                              {d}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Truthfulness Findings</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1.5">
                          {intelligence.truthfulness_details.map((d, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <span className={d.includes("REJECTED") || d.includes("critically") || d.includes("elevated") ? "text-red-400" : d.includes("not") || d.includes("gaps") ? "text-amber-400" : "text-emerald-400"}>·</span>
                              {d}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Administrative Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="mr-2 h-4 w-4" />
                Permanently Delete Record
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm Permanent Deletion</DialogTitle>
                <DialogDescription>
                  This action is irreversible. All data associated with this claimant — including documents,
                  notes, and compliance records — will be permanently removed from the system.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button variant="destructive" onClick={async () => {
                  try {
                    await deleteLead.mutateAsync({ id: leadId });
                    toast({ title: "Record permanently deleted" });
                    window.location.href = "/leads";
                  } catch {
                    toast({ title: "Deletion failed — please retry", variant: "destructive" });
                  }
                }} disabled={deleteLead.isPending}>
                  {deleteLead.isPending ? "Deleting..." : "Confirm Deletion"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}

function CustomFieldsCard({ tortType, customFields }: { tortType?: string | null; customFields?: Record<string, unknown> | null }) {
  const { data: configsData } = useGetFormConfigs();
  const all = ((configsData as { tort_campaigns?: Array<{ id: string; label: string; custom_fields?: Array<{ key: string; label: string; type: string }> }> })?.tort_campaigns) || [];
  const needle = (tortType || "").toLowerCase().trim();
  const cfg = all.find(c => c.id.toLowerCase() === needle || c.label.toLowerCase() === needle) || null;
  const cfgFields = (cfg?.custom_fields || []) as Array<{ key: string; label: string; type: string }>;
  const values = (customFields || {}) as Record<string, unknown>;
  const valueKeys = Object.keys(values);

  if (cfgFields.length === 0 && valueKeys.length === 0) return null;

  const seen = new Set<string>();
  const rows: Array<{ key: string; label: string; value: unknown }> = [];
  for (const f of cfgFields) {
    seen.add(f.key);
    rows.push({ key: f.key, label: f.label, value: values[f.key] });
  }
  for (const k of valueKeys) {
    if (!seen.has(k)) rows.push({ key: k, label: k.replace(/_/g, " "), value: values[k] });
  }

  const renderValue = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  return (
    <Card data-testid="card-custom-fields">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Custom Fields</CardTitle>
        <CardDescription>Form fields defined for the {tortType || "tort"} campaign.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-0">
        {rows.map(r => (
          <div key={r.key} className="flex flex-col py-2 border-b border-gray-100 last:border-0" data-testid={`row-cf-${r.key}`}>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{r.label}</span>
            <span className={`text-sm mt-0.5 ${values[r.key] !== undefined && values[r.key] !== null && values[r.key] !== "" ? "text-foreground" : "text-muted-foreground italic"}`}>
              {renderValue(r.value)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
