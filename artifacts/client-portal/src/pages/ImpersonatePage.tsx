import { useEffect, useState } from "react";
import { useSearch, useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { ShieldCheck, Loader2, XCircle } from "lucide-react";

// Landing page for admin impersonation links.
// Reads ?token= from the URL, stores it in memory only (no localStorage),
// then redirects to the dashboard. The token expires in 10 minutes.
export function ImpersonatePage() {
  const { tortSlug, loginWithToken } = usePortalAuth();
  const search = useSearch();
  const [, setLocation] = useLocation();

  const token = new URLSearchParams(search).get("token") ?? "";
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Invalid impersonation link — token is missing.");
      return;
    }

    loginWithToken(token).then(user => {
      if (!user) {
        setError("This impersonation link is invalid or has expired (10-minute window).");
        return;
      }
      // Clear the token from the URL bar before navigating to avoid accidental sharing.
      setLocation(`/${tortSlug}/dashboard`);
    });
  }, [token, tortSlug, loginWithToken, setLocation]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mb-4">
            <XCircle className="h-7 w-7 text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">Access Denied</h1>
          <p className="text-sm text-slate-500 mt-2">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#1e3a5f] mb-4">
          <ShieldCheck className="h-7 w-7 text-white" />
        </div>
        <Loader2 className="h-5 w-5 text-[#1e3a5f] animate-spin mx-auto mb-2" />
        <p className="text-sm text-slate-500">Opening client view…</p>
      </div>
    </div>
  );
}
