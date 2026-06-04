import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle, XCircle, FileSearch, Search, FileText, Brain, ShieldCheck } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";
import { apiFetchRaw } from "@/lib/api-fetch";

interface FieldComparison {
  field: string;
  intake_value: string;
  document_value: string;
  match: "match" | "mismatch" | "missing" | "extra";
}

export default function DocReview() {
  const { toast } = useToast();
  const [leadId, setLeadId] = useState("");
  const [faxId, setFaxId] = useState("");
  const [leadData, setLeadData] = useState<Record<string, any> | null>(null);
  const [ocrData, setOcrData] = useState<Record<string, any> | null>(null);
  const [aiFields, setAiFields] = useState<Record<string, any> | null>(null);
  const [comparisons, setComparisons] = useState<FieldComparison[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const loadLead = async () => {
    if (!leadId) return;
    try {
      const res = await apiFetchRaw(`/api/leads/${leadId}`);
      if (!res.ok) throw new Error("Lead not found");
      setLeadData(await res.json());
    } catch {
      toast({ title: "Lead not found", variant: "destructive" });
    }
  };

  const loadOcr = async () => {
    if (!faxId) return;
    try {
      const res = await apiFetchRaw(`/api/ocr/results/${faxId}`);
      if (!res.ok) throw new Error("OCR result not found");
      setOcrData(await res.json());
    } catch {
      toast({ title: "OCR result not found", variant: "destructive" });
    }
  };

  const runAiAnalysis = async () => {
    if (!faxId) return;
    setAnalyzing(true);
    try {
      const res = await apiFetchRaw(`/api/ocr/ai-fields/result/${faxId}`, { method: "POST" });
      if (!res.ok) throw new Error("Analysis failed");
      setAiFields(await res.json());
    } catch {
      toast({ title: "AI analysis failed", variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const compareData = () => {
    if (!leadData) return;
    const source = aiFields || ocrData;
    if (!source) return;

    const fields: FieldComparison[] = [];
    const compareField = (field: string, intakeKey: string, docValue: string | undefined) => {
      const intakeVal = String(leadData[intakeKey] || "");
      const docVal = String(docValue || "");
      let match: FieldComparison["match"] = "missing";
      if (!intakeVal && !docVal) return;
      if (!intakeVal && docVal) match = "extra";
      else if (intakeVal && !docVal) match = "missing";
      else if (intakeVal.toLowerCase().trim() === docVal.toLowerCase().trim()) match = "match";
      else match = "mismatch";
      fields.push({ field, intake_value: intakeVal, document_value: docVal, match });
    };

    compareField("Patient Name", "name", source.patient_name || `${source.drug_name || ""}`);
    compareField("Date of Birth", "date_of_birth", source.date_of_birth);
    compareField("Diagnosis", "diagnosis", source.diagnoses?.[0]?.description || source.drug_name);
    compareField("Diagnosis Date", "diagnosis_date", source.diagnoses?.[0]?.date || source.fill_date);
    compareField("Drug/Substance", "tort_type", source.medications?.[0]?.name || source.drug_name);
    compareField("Rx Number", "npi_number", source.rx_number);

    if (source.providers) {
      const intakePhysician = `${leadData.physician_first_name || ""} ${leadData.physician_last_name || ""}`.trim();
      for (const p of source.providers) {
        const intakeVal = intakePhysician;
        const docVal = String(p.name || "");
        let match: FieldComparison["match"] = "missing";
        if (!intakeVal && docVal) match = "extra";
        else if (intakeVal && !docVal) match = "missing";
        else if (intakeVal.toLowerCase() === docVal.toLowerCase()) match = "match";
        else match = "mismatch";
        fields.push({ field: `Provider: ${p.name}`, intake_value: intakeVal, document_value: docVal, match });
      }
    }

    if (source.exposure_details) {
      for (const e of source.exposure_details) {
        if (e.substance) compareField("Exposure Substance", "tort_type", e.substance);
        if (e.location) compareField("Exposure Location", "location_name", e.location);
      }
    }

    setComparisons(fields);
  };

  useEffect(() => { if (leadData && (ocrData || aiFields)) compareData(); }, [leadData, ocrData, aiFields]);

  const matchCounts = {
    match: comparisons.filter(c => c.match === "match").length,
    mismatch: comparisons.filter(c => c.match === "mismatch").length,
    missing: comparisons.filter(c => c.match === "missing").length,
    extra: comparisons.filter(c => c.match === "extra").length,
  };

  const fraudRisk = matchCounts.mismatch > 2 ? "high" : matchCounts.mismatch > 0 ? "medium" : "low";

  return (
    <div className="space-y-6">
      <WorkspaceHero
        eyebrow="Document review workspace"
        badge="Compare in business steps"
        title="Validate intake against records without bouncing between tools"
        description="This review area is now framed as a guided comparison flow: load the claimant record, load the incoming document, and let the mismatch panel direct human review."
        actions={[
          { label: "OCR inbox", href: "/ocr-inbox" },
          { label: "Medical records", href: "/medical-records" },
          { label: "Leads", href: "/leads" },
        ]}
        steps={[
          { title: "Load intake", description: "Pull the claimant's CRM data into the comparison workspace.", icon: FileText, href: "/leads", ctaLabel: "Open leads" },
          { title: "Analyze the document", description: "Load OCR or run deeper AI extraction on the fax result.", icon: Brain, href: "/ocr-inbox", ctaLabel: "Open OCR inbox" },
          { title: "Decide confidence", description: "Use mismatches and fraud risk to decide whether the record is trustworthy.", icon: ShieldCheck, href: "/medical-records", ctaLabel: "Continue record work" },
        ]}
      />

      <h1 className="text-3xl font-bold tracking-tight">Side-by-Side Document Review</h1>
      <p className="text-muted-foreground">Compare medical records against intake data to spot discrepancies and potential fraud.</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Intake Record</CardTitle>
            <CardDescription>Load lead data from the CRM</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input placeholder="Lead ID" value={leadId} onChange={(e) => setLeadId(e.target.value)} />
              <Button onClick={loadLead}><Search className="h-4 w-4 mr-2" />Load</Button>
            </div>
            {leadData && (
              <div className="mt-4 space-y-2 text-sm">
                <div><span className="font-medium">Name:</span> {leadData.name}</div>
                <div><span className="font-medium">Tort:</span> {leadData.tort_type}</div>
                <div><span className="font-medium">Diagnosis:</span> {leadData.diagnosis || "N/A"}</div>
                <div><span className="font-medium">Status:</span> <Badge variant="outline">{leadData.status}</Badge></div>
                <div><span className="font-medium">Fraud Score:</span> {leadData.fraud_score ?? "N/A"}</div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Document Record</CardTitle>
            <CardDescription>Load OCR/fax result for comparison</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input placeholder="Fax Result ID" value={faxId} onChange={(e) => setFaxId(e.target.value)} />
              <Button onClick={loadOcr}><FileSearch className="h-4 w-4 mr-2" />Load</Button>
            </div>
            {ocrData && (
              <div className="mt-4 space-y-2 text-sm">
                <div><span className="font-medium">Source:</span> {ocrData.source_file}</div>
                <div><span className="font-medium">Drug:</span> {ocrData.drug_name || "N/A"}</div>
                <div><span className="font-medium">Rx:</span> {ocrData.rx_number || "N/A"}</div>
                <div><span className="font-medium">Confidence:</span> {Math.round((ocrData.confidence || 0) * 100)}%</div>
                <Button variant="outline" size="sm" className="mt-2" onClick={runAiAnalysis} disabled={analyzing}>
                  {analyzing ? "Analyzing..." : "Run AI Deep Analysis"}
                </Button>
                {aiFields && <Badge className="ml-2 bg-green-100 text-green-700">AI Analysis Complete</Badge>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {comparisons.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  <div>
                    <div className="text-2xl font-bold text-green-600">{matchCounts.match}</div>
                    <div className="text-sm text-muted-foreground">Matches</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  <div>
                    <div className="text-2xl font-bold text-red-600">{matchCounts.mismatch}</div>
                    <div className="text-sm text-muted-foreground">Mismatches</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                  <div>
                    <div className="text-2xl font-bold text-yellow-600">{matchCounts.missing}</div>
                    <div className="text-sm text-muted-foreground">Missing in Doc</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className={fraudRisk === "high" ? "border-red-300 bg-red-50" : fraudRisk === "medium" ? "border-yellow-300 bg-yellow-50" : "border-green-300 bg-green-50"}>
              <CardContent className="pt-6">
                <div className="text-center">
                  <div className={`text-2xl font-bold ${fraudRisk === "high" ? "text-red-600" : fraudRisk === "medium" ? "text-yellow-600" : "text-green-600"}`}>
                    {fraudRisk.toUpperCase()}
                  </div>
                  <div className="text-sm text-muted-foreground">Fraud Risk</div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Field-by-Field Comparison</CardTitle>
              <CardDescription>Intake form data vs. extracted document data</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Intake Value</TableHead>
                    <TableHead>Document Value</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisons.map((c, i) => (
                    <TableRow key={i} className={c.match === "mismatch" ? "bg-red-50" : c.match === "match" ? "bg-green-50" : ""}>
                      <TableCell className="font-medium">{c.field}</TableCell>
                      <TableCell className="font-mono text-sm">{c.intake_value || "---"}</TableCell>
                      <TableCell className="font-mono text-sm">{c.document_value || "---"}</TableCell>
                      <TableCell>
                        <Badge className={
                          c.match === "match" ? "bg-green-100 text-green-700" :
                          c.match === "mismatch" ? "bg-red-100 text-red-700" :
                          c.match === "missing" ? "bg-yellow-100 text-yellow-700" :
                          "bg-blue-100 text-blue-700"
                        }>
                          {c.match.toUpperCase()}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {comparisons.length === 0 && leadData && ocrData && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Load both a lead and a document record, then comparison will appear automatically.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
