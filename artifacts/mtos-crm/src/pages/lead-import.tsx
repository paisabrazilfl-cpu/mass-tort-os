import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Copy, RefreshCw, ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface ImportBatch {
  id: number;
  filename: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_count: number;
  duplicate_count: number;
  error_count: number;
  conflict_count: number;
  created_at: string;
  completed_at: string | null;
}

interface PreviewResult {
  total_rows: number;
  headers: string[];
  column_mapping: Record<string, string>;
  unmapped_columns: string[];
  available_fields: string[];
  sample_leads: Record<string, any>[];
}

interface ImportRow {
  id: number;
  row_number: number;
  status: string;
  raw_data: Record<string, string>;
  lead_id: number | null;
  dedup_match_id: number | null;
  dedup_reason: string | null;
  error_message: string | null;
  conflict_details: any;
}

type Step = "upload" | "preview" | "importing" | "results";

export default function LeadImport() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("upload");
  const [csvData, setCsvData] = useState<string>("");
  const [filename, setFilename] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [activeBatch, setActiveBatch] = useState<ImportBatch | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [batchRows, setBatchRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState(false);
  const [expandedDupes, setExpandedDupes] = useState(false);

  const fetchBatches = useCallback(async () => {
    try {
      const res = await apiFetchRaw("/api/lead-import/batches");
      if (res.ok) setBatches(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".csv")) {
      toast({ title: "Invalid file", description: "Please upload a CSV file.", variant: "destructive" });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum file size is 10MB.", variant: "destructive" });
      return;
    }

    const text = await file.text();
    setCsvData(text);
    setFilename(file.name);
    setLoading(true);

    try {
      const res = await apiFetchRaw("/api/lead-import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_data: text }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Preview failed");
      }

      const data: PreviewResult = await res.json();
      setPreview(data);
      setColumnMapping(data.column_mapping);
      setStep("preview");
    } catch (err: any) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteImport = async () => {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/lead-import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_data: csvData,
          column_mapping: columnMapping,
          filename,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Import failed");
      }

      const data = await res.json();
      setActiveBatch({ ...data, filename, success_count: 0, duplicate_count: 0, error_count: 0, conflict_count: 0, created_at: new Date().toISOString(), completed_at: null } as ImportBatch);
      setStep("importing");

      pollBatchStatus(data.batch_id);
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const pollBatchStatus = async (batchId: number) => {
    const poll = async () => {
      try {
        const res = await apiFetchRaw(`/api/lead-import/batches/${batchId}`);
        if (!res.ok) return;
        const data = await res.json();
        const { rows, ...batch } = data;
        setActiveBatch(batch);
        setBatchRows(rows || []);

        if (batch.status === "completed") {
          setStep("results");
          fetchBatches();
          return;
        }
      } catch {}
      setTimeout(poll, 2000);
    };
    poll();
  };

  const handleViewBatch = async (batchId: number) => {
    try {
      const res = await apiFetchRaw(`/api/lead-import/batches/${batchId}`);
      if (!res.ok) return;
      const data = await res.json();
      const { rows, ...batch } = data;
      setActiveBatch(batch);
      setBatchRows(rows || []);
      setStep("results");
    } catch {}
  };

  const resetImport = () => {
    setStep("upload");
    setCsvData("");
    setFilename("");
    setPreview(null);
    setColumnMapping({});
    setActiveBatch(null);
    setBatchRows([]);
    setExpandedErrors(false);
    setExpandedDupes(false);
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      success: { variant: "default", label: "Imported" },
      duplicate: { variant: "secondary", label: "Duplicate" },
      error: { variant: "destructive", label: "Error" },
      rejected: { variant: "destructive", label: "Rejected" },
      conflict: { variant: "outline", label: "Conflict" },
      pending: { variant: "secondary", label: "Pending" },
    };
    const cfg = map[status] || { variant: "secondary" as const, label: status };
    return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lead Import</h1>
          <p className="text-muted-foreground mt-1">
            Bulk import leads from CSV files with full validation, deduplication, and conflict checking.
          </p>
        </div>
        {step !== "upload" && (
          <Button variant="outline" onClick={resetImport}>
            <Upload className="h-4 w-4 mr-2" />
            New Import
          </Button>
        )}
      </div>

      {step === "upload" && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" />
                Upload CSV
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="border-2 border-dashed rounded-lg p-8 text-center">
                <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
                <p className="text-sm text-muted-foreground mb-4">
                  Drop a CSV file here or click to browse
                </p>
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="csv-upload"
                />
                <label htmlFor="csv-upload">
                  <Button asChild variant="outline" disabled={loading}>
                    <span>{loading ? "Analyzing..." : "Choose File"}</span>
                  </Button>
                </label>
              </div>
              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <p>Each lead is individually validated through the full pipeline:</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Data integrity checks (required fields, format validation)</li>
                  <li>Deduplication against existing CRM leads (email, phone)</li>
                  <li>Conflict detection (geography, diagnosis-tort matching)</li>
                  <li>Encryption of sensitive fields (SSN, DOB, medical data)</li>
                  <li>Audit trail logging for every imported lead</li>
                </ul>
                <p className="font-medium mt-2">Maximum: 5,000 rows per import</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Import History</CardTitle>
            </CardHeader>
            <CardContent>
              {batches.length === 0 ? (
                <p className="text-sm text-muted-foreground">No previous imports</p>
              ) : (
                <div className="space-y-3">
                  {batches.slice(0, 10).map(batch => (
                    <div
                      key={batch.id}
                      className="flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-muted/50"
                      onClick={() => handleViewBatch(batch.id)}
                    >
                      <div>
                        <p className="text-sm font-medium">{batch.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(batch.created_at).toLocaleDateString()} — {batch.total_rows} rows
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-green-600">{batch.success_count} ok</span>
                        {batch.duplicate_count > 0 && <span className="text-xs text-amber-600">{batch.duplicate_count} dup</span>}
                        {batch.error_count > 0 && <span className="text-xs text-red-600">{batch.error_count} err</span>}
                        <Badge variant={batch.status === "completed" ? "default" : "secondary"}>
                          {batch.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === "preview" && preview && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Column Mapping</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                {preview.total_rows} rows detected in <span className="font-medium">{filename}</span>.
                Review the column mapping below.
              </p>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {preview.headers.map(header => (
                  <div key={header} className="flex items-center gap-2 p-2 rounded border text-sm">
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded flex-shrink-0">{header}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    {columnMapping[header] ? (
                      <Badge variant="default" className="text-xs">{columnMapping[header]}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-amber-600">unmapped</Badge>
                    )}
                  </div>
                ))}
              </div>
              {preview.unmapped_columns.length > 0 && (
                <p className="text-xs text-amber-600 mt-3">
                  {preview.unmapped_columns.length} column(s) unmapped and will be skipped: {preview.unmapped_columns.join(", ")}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sample Preview (First 5 Rows)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2 text-left font-medium">#</th>
                      {Object.values(columnMapping).slice(0, 8).map(field => (
                        <th key={field} className="p-2 text-left font-medium">{field}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample_leads.map((lead, i) => (
                      <tr key={i} className="border-b">
                        <td className="p-2 text-muted-foreground">{i + 1}</td>
                        {Object.values(columnMapping).slice(0, 8).map(field => (
                          <td key={field} className="p-2 max-w-[150px] truncate">
                            {lead[field] || <span className="text-muted-foreground italic">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-4">
            <Button onClick={handleExecuteImport} disabled={loading} size="lg">
              {loading ? "Starting Import..." : `Import ${preview.total_rows} Leads`}
            </Button>
            <Button variant="outline" onClick={resetImport}>Cancel</Button>
            <p className="text-xs text-muted-foreground">
              Each lead will be individually validated, deduped, and conflict-checked before insertion.
            </p>
          </div>
        </>
      )}

      {step === "importing" && activeBatch && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 animate-spin" />
              Importing {filename}...
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="w-full bg-muted rounded-full h-3">
                <div
                  className="bg-primary h-3 rounded-full transition-all duration-500"
                  style={{ width: `${activeBatch.total_rows > 0 ? (activeBatch.processed_rows / activeBatch.total_rows) * 100 : 0}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>{activeBatch.processed_rows} / {activeBatch.total_rows} rows processed</span>
                <span className="text-muted-foreground">
                  {activeBatch.total_rows > 0 ? Math.round((activeBatch.processed_rows / activeBatch.total_rows) * 100) : 0}%
                </span>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-2xl font-bold text-green-700">{activeBatch.success_count}</p>
                  <p className="text-xs text-green-600">Imported</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <p className="text-2xl font-bold text-amber-700">{activeBatch.duplicate_count}</p>
                  <p className="text-xs text-amber-600">Duplicates</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-orange-50 border border-orange-200">
                  <p className="text-2xl font-bold text-orange-700">{activeBatch.conflict_count}</p>
                  <p className="text-xs text-orange-600">Conflicts</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-red-50 border border-red-200">
                  <p className="text-2xl font-bold text-red-700">{activeBatch.error_count}</p>
                  <p className="text-xs text-red-600">Errors</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "results" && activeBatch && (
        <>
          <div className="grid gap-4 md:grid-cols-5">
            <Card className="border-green-200 bg-green-50">
              <CardContent className="pt-6 text-center">
                <CheckCircle2 className="h-8 w-8 mx-auto text-green-600 mb-2" />
                <p className="text-3xl font-bold text-green-700">{activeBatch.success_count}</p>
                <p className="text-sm text-green-600">Successfully Imported</p>
              </CardContent>
            </Card>
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="pt-6 text-center">
                <Copy className="h-8 w-8 mx-auto text-amber-600 mb-2" />
                <p className="text-3xl font-bold text-amber-700">{activeBatch.duplicate_count}</p>
                <p className="text-sm text-amber-600">Duplicates Skipped</p>
              </CardContent>
            </Card>
            <Card className="border-orange-200 bg-orange-50">
              <CardContent className="pt-6 text-center">
                <AlertTriangle className="h-8 w-8 mx-auto text-orange-600 mb-2" />
                <p className="text-3xl font-bold text-orange-700">{activeBatch.conflict_count}</p>
                <p className="text-sm text-orange-600">Sent to Review</p>
              </CardContent>
            </Card>
            <Card className="border-red-200 bg-red-50">
              <CardContent className="pt-6 text-center">
                <XCircle className="h-8 w-8 mx-auto text-red-600 mb-2" />
                <p className="text-3xl font-bold text-red-700">{activeBatch.error_count}</p>
                <p className="text-sm text-red-600">Errors / Rejected</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <FileSpreadsheet className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-3xl font-bold">{activeBatch.total_rows}</p>
                <p className="text-sm text-muted-foreground">Total Rows</p>
              </CardContent>
            </Card>
          </div>

          {batchRows.filter(r => r.status === "duplicate").length > 0 && (
            <Card>
              <CardHeader
                className="cursor-pointer"
                onClick={() => setExpandedDupes(!expandedDupes)}
              >
                <CardTitle className="flex items-center justify-between text-amber-700">
                  <span className="flex items-center gap-2">
                    <Copy className="h-5 w-5" />
                    Duplicates ({batchRows.filter(r => r.status === "duplicate").length})
                  </span>
                  {expandedDupes ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </CardTitle>
              </CardHeader>
              {expandedDupes && (
                <CardContent>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {batchRows.filter(r => r.status === "duplicate").map(row => (
                      <div key={row.id} className="flex items-center justify-between p-2 rounded border text-sm">
                        <span className="text-muted-foreground">Row {row.row_number}</span>
                        <span className="font-mono text-xs">{(row.raw_data as any)?.name || (row.raw_data as any)?.["First Name"] || "—"}</span>
                        <span className="text-xs text-amber-600">{row.dedup_reason}</span>
                        {row.dedup_match_id && (
                          <a href={`/leads/${row.dedup_match_id}`} className="text-xs text-primary underline">
                            View Match #{row.dedup_match_id}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {batchRows.filter(r => r.status === "error" || r.status === "rejected").length > 0 && (
            <Card>
              <CardHeader
                className="cursor-pointer"
                onClick={() => setExpandedErrors(!expandedErrors)}
              >
                <CardTitle className="flex items-center justify-between text-red-700">
                  <span className="flex items-center gap-2">
                    <XCircle className="h-5 w-5" />
                    Errors & Rejections ({batchRows.filter(r => r.status === "error" || r.status === "rejected").length})
                  </span>
                  {expandedErrors ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </CardTitle>
              </CardHeader>
              {expandedErrors && (
                <CardContent>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {batchRows.filter(r => r.status === "error" || r.status === "rejected").map(row => (
                      <div key={row.id} className="p-2 rounded border text-sm space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Row {row.row_number}</span>
                          {statusBadge(row.status)}
                        </div>
                        <p className="text-xs text-red-600">{row.error_message}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
