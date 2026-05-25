import { useEffect, useState } from "react";
import { portalFetch, describeError, type ApiError } from "../lib/api";
import { CheckCircle2, Clock, AlertCircle, FileText, PenLine } from "lucide-react";
import { cn } from "../lib/cn";

interface Envelope {
  id: string;
  name: string;
  provider: string;
  status: string;
  status_label: string;
  action_required: boolean;
  sent_at: string | null;
  delivered_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  created_at: string;
}

interface Doc {
  id: string;
  type: string;
  type_label: string;
  file_name: string;
  signed: boolean;
  signed_at: string | null;
  created_at: string;
}

interface Summary {
  total_envelopes: number;
  signed: number;
  action_required: number;
}

interface DocsResponse {
  envelopes: Envelope[];
  documents: Doc[];
  summary: Summary;
}

function formatDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function EnvelopeStatusBadge({ status, actionRequired }: { status: string; actionRequired: boolean }) {
  const cfg =
    status === "signed"                              ? { cls: "bg-green-100 text-green-700", icon: CheckCircle2 } :
    actionRequired                                   ? { cls: "bg-amber-100 text-amber-700", icon: AlertCircle } :
    status === "declined" || status === "voided"     ? { cls: "bg-red-100 text-red-700",    icon: AlertCircle } :
    status === "expired"                             ? { cls: "bg-orange-100 text-orange-700", icon: AlertCircle } :
                                                       { cls: "bg-slate-100 text-slate-600", icon: Clock };

  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", cfg.cls)}>
      <Icon className="h-3 w-3" />
      {status === "signed" ? "Signed"
        : actionRequired ? "Signature Needed"
        : status === "declined" ? "Declined"
        : status === "voided" ? "Voided"
        : status === "expired" ? "Expired"
        : "Preparing"}
    </span>
  );
}

export function DocumentsPage() {
  const [data, setData] = useState<DocsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    portalFetch<DocsResponse>("/api/portal/documents")
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
        {error || "Failed to load documents."}
      </div>
    );
  }

  const { envelopes, documents, summary } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Documents</h1>
        <p className="text-sm text-slate-500 mt-0.5">Legal agreements sent to you for signature.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total", value: summary.total_envelopes },
          { label: "Signed", value: summary.signed },
          { label: "Need signature", value: summary.action_required },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-xl border border-slate-200 px-3 py-3 text-center shadow-sm">
            <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Action required notice */}
      {summary.action_required > 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">
              {summary.action_required} document{summary.action_required !== 1 ? "s" : ""} need{summary.action_required === 1 ? "s" : ""} your signature
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              Check your email for a DocuSign link — or contact your case manager if you haven't received it.
            </p>
          </div>
        </div>
      )}

      {/* Envelopes */}
      {envelopes.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">E-Signature Agreements</h2>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {envelopes.map(env => (
              <div key={env.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="p-1.5 rounded-lg bg-[#1e3a5f]/10 mt-0.5">
                      <PenLine className="h-4 w-4 text-[#1e3a5f]" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{env.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {env.sent_at ? `Sent ${formatDate(env.sent_at)}` : `Created ${formatDate(env.created_at)}`}
                        {env.signed_at && ` · Signed ${formatDate(env.signed_at)}`}
                      </p>
                    </div>
                  </div>
                  <EnvelopeStatusBadge status={env.status} actionRequired={env.action_required} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {envelopes.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-10 text-center">
          <FileText className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No documents have been sent yet.</p>
          <p className="text-xs text-slate-400 mt-1">Documents will appear here once your case manager sends them.</p>
        </div>
      )}

      {/* Supporting documents */}
      {documents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Additional Files</h2>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {documents.map(doc => (
              <div key={doc.id} className="px-4 py-3 flex items-center gap-3">
                <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{doc.type_label}</p>
                  {doc.file_name && <p className="text-xs text-slate-400 truncate">{doc.file_name}</p>}
                </div>
                {doc.signed && (
                  <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
