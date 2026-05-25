import { useEffect, useState, useCallback } from "react";
import { useSearch } from "wouter";
import { portalFetch, describeError, ApiError } from "../lib/api";
import { CheckCircle2, Clock, AlertCircle, Stethoscope, FileText, Wifi, WifiOff, Plus, Loader2 } from "lucide-react";
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
  id: number;
  name: string;
  backend: string;
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

interface FastenStatus {
  enabled: boolean;
  backend?: string;
  connections?: Provider[];
}

function formatDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ProviderStatusIcon({ status, needsAttention }: { status: string; needsAttention: boolean }) {
  if (needsAttention) return <AlertCircle className="h-4 w-4 text-amber-500" />;
  if (status === "active" || status === "synced") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "syncing" || status === "pending") return <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />;
  if (status === "revoked") return <WifiOff className="h-4 w-4 text-slate-400" />;
  return <Clock className="h-4 w-4 text-slate-400" />;
}

export function RecordsPage() {
  const search = useSearch();
  const justConnected = new URLSearchParams(search).get("connected") === "1";

  const [data, setData] = useState<RecordsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [fastenStatus, setFastenStatus] = useState<FastenStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [revoking, setRevoking] = useState<number | null>(null);

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

  const loadFastenStatus = useCallback(async () => {
    try {
      const d = await portalFetch<FastenStatus>("/api/portal/fasten/status");
      setFastenStatus(d);
    } catch {
      // Non-critical — Fasten may not be configured for this tort type.
    }
  }, []);

  useEffect(() => {
    void loadRecords();
    void loadFastenStatus();
  }, [loadRecords, loadFastenStatus]);

  async function handleConnect() {
    setConnecting(true);
    setConnectError("");
    try {
      const result = await portalFetch<{ connect_url: string }>("/api/portal/fasten/connect", {
        method: "POST",
        body: JSON.stringify({}),
      });
      // Redirect the patient browser to the Fasten OAuth page.
      window.location.href = result.connect_url;
    } catch (err) {
      setConnectError(describeError(err as ApiError, "Unable to start provider connection. Please try again."));
      setConnecting(false);
    }
  }

  async function handleRevoke(connectionId: number) {
    setRevoking(connectionId);
    try {
      await portalFetch(`/api/portal/fasten/connections/${connectionId}`, { method: "DELETE" });
      // Reload both lists to reflect the revocation.
      await Promise.all([loadRecords(), loadFastenStatus()]);
    } catch {
      // silent — connection list will show stale state until next load
    } finally {
      setRevoking(null);
    }
  }

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
  const activeProviders = providers.filter(p => p.status !== "revoked");
  const fastenEnabled = fastenStatus?.enabled === true;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Medical Records</h1>
        <p className="text-sm text-slate-500 mt-0.5">Records received by your legal team.</p>
      </div>

      {/* Just-connected success banner */}
      {justConnected && (
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-green-800">Provider connected</p>
            <p className="text-xs text-green-600 mt-0.5">
              Your health portal has been linked. Records are being retrieved — this may take a few minutes.
            </p>
          </div>
        </div>
      )}

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

      {/* Connect health portal (Fasten) */}
      {fastenEnabled && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Wifi className="h-4 w-4 text-[#1e3a5f]" />
                Connect Health Portal
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Link your patient portal directly to share records instantly — no faxing required.
              </p>
            </div>
            <button
              onClick={() => void handleConnect()}
              disabled={connecting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1e3a5f] text-white text-xs font-semibold hover:bg-[#2d5a9e] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              {connecting
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</>
                : <><Plus className="h-3.5 w-3.5" /> Connect Provider</>
              }
            </button>
          </div>

          {connectError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{connectError}</p>
          )}

          {/* Active provider connections */}
          {activeProviders.length > 0 && (
            <div className="divide-y divide-slate-100 border border-slate-100 rounded-xl overflow-hidden">
              {activeProviders.map(p => (
                <div key={p.id} className="flex items-center gap-3 px-3 py-3">
                  <ProviderStatusIcon status={p.status} needsAttention={p.needs_attention} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{p.name}</p>
                    <p className="text-xs text-slate-400">
                      {p.status_label}
                      {p.records_count > 0 && ` · ${p.records_count} records`}
                      {p.last_synced_at && ` · Last synced ${formatDate(p.last_synced_at)}`}
                    </p>
                    {p.needs_attention && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Reconnection required — contact your case manager for help.
                      </p>
                    )}
                  </div>
                  {p.status !== "revoked" && (
                    <button
                      onClick={() => void handleRevoke(p.id)}
                      disabled={revoking === p.id}
                      className="text-xs text-slate-400 hover:text-red-500 transition-colors flex-shrink-0"
                      title="Disconnect this provider"
                    >
                      {revoking === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeProviders.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-2">
              No providers connected yet. Click "Connect Provider" to get started.
            </p>
          )}
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
      {!hasRecords && !fastenEnabled && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-10 text-center">
          <Stethoscope className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No records yet</p>
          <p className="text-xs text-slate-400 mt-1">Medical records will appear here once received.</p>
        </div>
      )}
    </div>
  );
}
