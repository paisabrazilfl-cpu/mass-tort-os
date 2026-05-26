import { useEffect, useState, useCallback } from "react";
import { portalFetch, describeError, ApiError } from "../lib/api";
import { CheckCircle2, Clock, Stethoscope, FileText } from "lucide-react";

interface MedDoc {
  id: string;
  type: string;
  type_label: string;
  file_name: string;
  received_at: string;
}

interface FaxResult {
  id: string;
  status: string;
  drug_name: string | null;
  confidence: number | null;
  received_at: string;
  processed_at: string | null;
}

interface RecordsResponse {
  records: {
    documents: MedDoc[];
    fax_results: FaxResult[];
    total_received: number;
  };
}

function formatDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function RecordsPage() {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRecords = useCallback(async () => {
    try {
      const d = await portalFetch<RecordsResponse>("/api/portal/records");
      setData(d);
    } catch (err) {
      setError(describeError(err as ApiError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-7 w-7 border-2 border-[#1e3a5f] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-4 text-sm text-red-700">
        {error || "Failed to load records."}
      </div>
    );
  }

  const { records } = data;
  const hasRecords = records.total_received > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Medical Records</h1>
        <p className="text-sm text-slate-500 mt-0.5">Records received by your legal team.</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 px-3 py-3 text-center shadow-sm">
          <p className="text-2xl font-bold text-slate-900">{records.total_received}</p>
          <p className="text-xs text-slate-500 mt-0.5">Records received</p>
        </div>
      </div>

      {/* HIPAA request status */}
      {!hasRecords && (
        <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 flex items-start gap-3">
          <Clock className="h-5 w-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Records are being requested</p>
            <p className="text-xs text-blue-600 mt-0.5">
              Once your documents are signed, we send a HIPAA authorization to your doctor or hospital.
              Records typically arrive within 2–4 weeks.
            </p>
          </div>
        </div>
      )}

      {/* Faxed / uploaded records */}
      {(records.documents.length > 0 || records.fax_results.length > 0) && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Received Records</h2>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {records.documents.map(doc => (
              <div key={doc.id} className="px-4 py-3 flex items-center gap-3">
                <div className="p-1.5 rounded-lg bg-green-50">
                  <FileText className="h-4 w-4 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">{doc.type_label}</p>
                  {doc.file_name && <p className="text-xs text-slate-400 truncate">{doc.file_name}</p>}
                  <p className="text-xs text-slate-400">Received {formatDate(doc.received_at)}</p>
                </div>
                <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
              </div>
            ))}

            {records.fax_results.map(fax => (
              <div key={fax.id} className="px-4 py-3 flex items-center gap-3">
                <div className="p-1.5 rounded-lg bg-green-50">
                  <Stethoscope className="h-4 w-4 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {fax.drug_name ? `Records — ${fax.drug_name}` : "Medical Record"}
                  </p>
                  <p className="text-xs text-slate-400">
                    {fax.processed_at ? `Processed ${formatDate(fax.processed_at)}` : `Received ${formatDate(fax.received_at)}`}
                  </p>
                </div>
                <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasRecords && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-10 text-center">
          <Stethoscope className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No records yet</p>
          <p className="text-xs text-slate-400 mt-1">Medical records will appear here once received.</p>
        </div>
      )}
    </div>
  );
}
