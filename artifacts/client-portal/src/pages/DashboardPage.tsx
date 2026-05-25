import { useEffect, useState } from "react";
import { portalFetch, describeError, type ApiError } from "../lib/api";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import {
  CheckCircle2, Clock, AlertCircle, CircleDashed, ArrowRight,
  FileText, Stethoscope, Scale
} from "lucide-react";
import { cn } from "../lib/cn";

type StepStatus = "complete" | "action_required" | "pending" | "waiting" | "review";

interface TimelineStep {
  step: string;
  label: string;
  status: StepStatus;
  date: string | null;
}

interface CaseData {
  id: string;
  tort_type: string;
  status: string;
  created_at: string;
  physician: string | null;
  hospital_name: string | null;
  documents: { total: number; signed: number; pending: number };
  medical_records: { fax_records_count: number; document_records_count: number; received: boolean };
}

interface CaseResponse {
  case: CaseData;
  timeline: TimelineStep[];
}

const STATUS_CONFIG: Record<StepStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  complete:        { icon: CheckCircle2, color: "text-green-600",  label: "Complete" },
  action_required: { icon: AlertCircle,  color: "text-amber-500",  label: "Action Required" },
  pending:         { icon: Clock,        color: "text-blue-500",   label: "In Progress" },
  waiting:         { icon: CircleDashed, color: "text-slate-300",  label: "Waiting" },
  review:          { icon: Clock,        color: "text-orange-500", label: "Under Review" },
};

function formatDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function TortIcon({ tortType }: { tortType: string }) {
  if (tortType?.toLowerCase().includes("camp")) return <Scale className="h-5 w-5" />;
  if (tortType?.toLowerCase().includes("medication") || tortType?.toLowerCase().includes("drug")) return <Stethoscope className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

export function DashboardPage() {
  const { me } = usePortalAuth();
  const [data, setData] = useState<CaseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    portalFetch<CaseResponse>("/api/portal/case")
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
        {error || "Failed to load case data."}
      </div>
    );
  }

  const { case: c, timeline } = data;
  const completedSteps = timeline.filter(s => s.status === "complete").length;
  const progress = Math.round((completedSteps / timeline.length) * 100);

  // Find next action
  const nextAction = timeline.find(s => s.status === "action_required" || s.status === "pending");

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-xl font-bold text-slate-900">
          Welcome back, {me?.name?.split(" ")[0] || "there"}
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">Here's the latest on your case.</p>
      </div>

      {/* Case card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="p-1.5 rounded-lg bg-[#1e3a5f]/10 text-[#1e3a5f]">
                <TortIcon tortType={c.tort_type} />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                {c.tort_type?.replace(/_/g, " ") || "Mass Tort Case"}
              </span>
            </div>
            <p className="text-xs text-slate-400">Case opened {formatDate(c.created_at)}</p>
          </div>
          <span className={cn(
            "px-2.5 py-1 rounded-full text-xs font-semibold",
            c.status === "active" || c.status === "qualified"
              ? "bg-green-100 text-green-700"
              : "bg-slate-100 text-slate-600",
          )}>
            {c.status?.replace(/_/g, " ") || "Active"}
          </span>
        </div>

        {/* Progress bar */}
        <div className="mt-4">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-xs font-medium text-slate-600">Case progress</span>
            <span className="text-xs font-bold text-[#1e3a5f]">{completedSteps}/{timeline.length} steps</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#1e3a5f] rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-50 px-3 py-2.5">
            <p className="text-xs text-slate-500">Documents signed</p>
            <p className="text-lg font-bold text-slate-900 mt-0.5">
              {c.documents.signed}<span className="text-sm font-normal text-slate-400">/{c.documents.total}</span>
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2.5">
            <p className="text-xs text-slate-500">Medical records</p>
            <p className="text-lg font-bold text-slate-900 mt-0.5">
              {c.medical_records.received ? "Received" : "Pending"}
            </p>
          </div>
        </div>
      </div>

      {/* Next action banner */}
      {nextAction && (
        <div className={cn(
          "rounded-xl border px-4 py-3 flex items-center gap-3",
          nextAction.status === "action_required"
            ? "bg-amber-50 border-amber-200"
            : "bg-blue-50 border-blue-200",
        )}>
          <AlertCircle className={cn("h-5 w-5 flex-shrink-0", nextAction.status === "action_required" ? "text-amber-500" : "text-blue-400")} />
          <div>
            <p className={cn("text-sm font-semibold", nextAction.status === "action_required" ? "text-amber-800" : "text-blue-800")}>
              {nextAction.status === "action_required" ? "Action needed:" : "In progress:"}
              {" "}{nextAction.label}
            </p>
            {nextAction.status === "action_required" && (
              <p className="text-xs text-amber-600 mt-0.5">Please check your email for a signing link.</p>
            )}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Case Timeline</h2>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {timeline.map((step, i) => {
            const cfg = STATUS_CONFIG[step.status];
            const Icon = cfg.icon;
            const isLast = i === timeline.length - 1;

            return (
              <div key={step.step} className={cn("flex items-start gap-3 px-4 py-3.5", step.status === "waiting" && "opacity-50")}>
                <div className="flex flex-col items-center pt-0.5">
                  <Icon className={cn("h-4.5 w-4.5 flex-shrink-0", cfg.color)} />
                  {!isLast && <div className="w-px h-5 bg-slate-100 mt-1" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn("text-sm font-medium", step.status === "waiting" ? "text-slate-400" : "text-slate-800")}>
                      {step.label}
                    </p>
                    {step.status !== "waiting" && (
                      <span className={cn("text-xs font-medium flex-shrink-0", cfg.color)}>
                        {cfg.label}
                      </span>
                    )}
                  </div>
                  {step.date && (
                    <p className="text-xs text-slate-400 mt-0.5">{formatDate(step.date)}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Provider info (if available) */}
      {(c.physician || c.hospital_name) && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Medical Provider</h2>
          {c.physician && <p className="text-sm text-slate-800">{c.physician}</p>}
          {c.hospital_name && <p className="text-sm text-slate-500">{c.hospital_name}</p>}
        </div>
      )}
    </div>
  );
}
