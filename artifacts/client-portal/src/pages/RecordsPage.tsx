import { useEffect, useState } from "react";
import { portalFetch, describeError, type ApiError } from "../lib/api";
import { CheckCircle2, Clock, AlertCircle, Stethoscope, FileText, Wifi } from "lucide-react";
import { cn } from "../lib/cn";

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

interface Provider {
  id: string;
  name: string;
  status: string;
  status_label: string;
  needs_attention: boolean;
  last_synced_at: string | null;
  records_count: number;
  connected_at: string;
}

interface Summary {
  records_received: number;
  providers_connected: number;
  providers_needing_attention: number;
}

interface RecordsResponse {
  records: {
    documents: MedDoc[];
    fax_results: FaxResult[];
    total_received: number;
  };
  providers: Provider[];
  summary: Summary;
}

function formatDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ProviderStatusIcon({ status, needsAttention }: { status: string; needsAttention: boolean }) {
  if (needsAttention) return <AlertCircle className="h-4 w-4 text-amber-500" />;
  if (status === "active" || status === "synced") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "syncing") return <Clock className="h-4 w-4 text-blue-500" />;
  if (status === "revoked") return <AlertCircle className="h-4 w-4 text-slate-400" />;
  return <Clock className="h-4 w-4 text-slate-400" />;
}

export function RecordsPage() {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    portalFetch<RecordsResponse>("/api/portal/records")
      .then(d => { setData(d); setLoading(false); })
      .catch(err => { setError(describeError(err as ApiError)); setLoading(false); });
  }, []);

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

  const { records, providers, summary } = data;
  const hasRecords = records.total_received > 0;
  const hasProviders = providers.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Medical Records</h1>
        <p className="text-sm text-slate-500 mt-0.5">Records received by your legal team.</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Records received", value: summary.records_received },
          { label: "Providers linked", value: summary.providers_connected },
          { label: "Needs attention", value: summary.providers_needing_attention },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-xl border border-slate-200 px-3 py-3 text-center shadow-sm">
            <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* HIPAA request info */}
      {!hasRecords && (
        <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 flex items-start gap-3">
          <Clock className="h-5 w-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Records are being requested</p>
            <p className="text-xs text-blue-600 mt-0.5">
              Once your documents are signed, we send a HIPAA authorization to your doctor or hospital. Records typically arrive within 2–4 weeks.
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

      {/* Provider connections */}
      {hasProviders && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Connected Health Portals</h2>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {providers.map(p => (
              <div key={p.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "p-1.5 rounded-lg mt-0.5",
                      p.needs_attention ? "bg-amber-50" : "bg-blue-50",
                    )}>
                      <Wifi className={cn("h-4 w-4", p.needs_attention ? "text-amber-500" : "text-blue-500")} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{p.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {p.records_count > 0 ? `${p.records_count} records synced` : "No records yet"}
                        {p.last_synced_at && ` · Last synced ${formatDate(p.last_synced_at)}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <ProviderStatusIcon status={p.status} needsAttention={p.needs_attention} />
                    <span className={cn(
                      "text-xs font-medium",
                      p.needs_attention ? "text-amber-600"
                        : p.status === "active" || p.status === "synced" ? "text-green-600"
                        : "text-slate-500",
                    )}>
                      {p.status_label}
                    </span>
                  </div>
                </div>

                {p.needs_attention && (
                  <div className="mt-2 ml-9 text-xs text-amber-600">
                    This connection needs to be re-authorized. Contact your case manager for assistance.
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasRecords && !hasProviders && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-10 text-center">
          <Stethoscope className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No records yet</p>
          <p className="text-xs text-slate-400 mt-1">Medical records will appear here once received.</p>
        </div>
      )}
    </div>
  );
}
