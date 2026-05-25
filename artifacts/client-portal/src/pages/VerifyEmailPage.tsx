import { useEffect, useState } from "react";
import { useSearch, useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { publicFetch, describeError, type ApiError } from "../lib/api";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

export function VerifyEmailPage() {
  const { tortSlug } = usePortalAuth();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const token = new URLSearchParams(search).get("token") ?? "";

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Invalid verification link.");
      return;
    }
    publicFetch<{ message: string }>(`/api/portal/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(data => {
        setStatus("success");
        setMessage(data.message || "Email verified successfully.");
      })
      .catch(err => {
        setStatus("error");
        setMessage(describeError(err as ApiError, "This verification link is invalid or has expired."));
      });
  }, [token]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm text-center">
        {status === "loading" && (
          <>
            <Loader2 className="h-12 w-12 text-[#1e3a5f] animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-bold text-slate-900">Verifying your email…</h1>
          </>
        )}

        {status === "success" && (
          <>
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mb-4">
              <CheckCircle2 className="h-7 w-7 text-green-600" />
            </div>
            <h1 className="text-xl font-bold text-slate-900">Email Verified</h1>
            <p className="text-sm text-slate-500 mt-2">{message}</p>
            <button
              onClick={() => setLocation(`/${tortSlug}/login`)}
              className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] transition-colors"
            >
              Sign In
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mb-4">
              <XCircle className="h-7 w-7 text-red-500" />
            </div>
            <h1 className="text-xl font-bold text-slate-900">Verification Failed</h1>
            <p className="text-sm text-slate-500 mt-2">{message}</p>
            <button
              onClick={() => setLocation(`/${tortSlug}/login`)}
              className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] transition-colors"
            >
              Go to Sign In
            </button>
          </>
        )}
      </div>
    </div>
  );
}
