import { useState, useEffect, type FormEvent } from "react";
import { useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { portalFetch, describeError, type ApiError } from "../lib/api";
import { ShieldCheck, Smartphone, CheckCircle2 } from "lucide-react";

interface SetupResponse {
  otpauth_url: string;
  secret: string;
}

export function MfaSetupPage() {
  const { tortSlug, refreshMe } = usePortalAuth();
  const [, setLocation] = useLocation();

  const [setupData, setSetupData] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    portalFetch<SetupResponse>("/api/portal/auth/mfa/setup", { method: "POST" })
      .then(data => { setSetupData(data); setSetupLoading(false); })
      .catch(err => { setError(describeError(err as ApiError)); setSetupLoading(false); });
  }, []);

  // Build QR code URL using Google Charts API (no external dep required).
  const qrUrl = setupData
    ? `https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encodeURIComponent(setupData.otpauth_url)}`
    : null;

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await portalFetch("/api/portal/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ totp_code: code.trim() }),
      });
      await refreshMe();
      setDone(true);
    } catch (err) {
      setError(describeError(err as ApiError, "Incorrect code — please try again."));
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 py-12">
        <div className="w-full max-w-sm text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mb-4">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">Two-factor authentication enabled</h1>
          <p className="text-sm text-slate-500 mt-2">
            Your account is now protected. You'll enter a code each time you sign in.
          </p>
          <button
            onClick={() => setLocation(`/${tortSlug}/dashboard`)}
            className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] transition-colors"
          >
            Continue to My Case
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#1e3a5f] mb-4">
            <ShieldCheck className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Secure your account</h1>
          <p className="text-sm text-slate-500 mt-1">
            Two-factor authentication is required to protect your medical and legal records.
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          {setupLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 border-2 border-[#1e3a5f] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : setupData ? (
            <>
              {/* Step 1 */}
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1e3a5f] text-white text-xs font-bold flex items-center justify-center mt-0.5">1</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">Install an authenticator app</p>
                  <p className="text-xs text-slate-500 mt-0.5">Google Authenticator, Authy, or Microsoft Authenticator</p>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1e3a5f] text-white text-xs font-bold flex items-center justify-center mt-0.5">2</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">Scan this QR code</p>
                </div>
              </div>

              {qrUrl && (
                <div className="flex justify-center mb-2">
                  <div className="p-2 border border-slate-200 rounded-xl inline-block bg-white">
                    <img src={qrUrl} alt="QR code for authenticator app" className="w-[180px] h-[180px]" />
                  </div>
                </div>
              )}

              {/* Manual key */}
              <details className="mb-4">
                <summary className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer hover:text-slate-700 select-none">
                  <Smartphone className="h-3 w-3" />
                  Can't scan the code? Enter manually
                </summary>
                <div className="mt-2 bg-slate-50 rounded-lg px-3 py-2">
                  <p className="text-xs text-slate-500 mb-1">Manual entry key:</p>
                  <code className="text-xs font-mono text-slate-800 break-all">{setupData.secret}</code>
                </div>
              </details>

              {/* Step 3 */}
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1e3a5f] text-white text-xs font-bold flex items-center justify-center mt-0.5">3</div>
                <div>
                  <p className="text-sm font-medium text-slate-800">Enter the 6-digit code</p>
                </div>
              </div>

              <form onSubmit={(e) => void handleVerify(e)} noValidate>
                {error && (
                  <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-sm text-red-700">
                    {error}
                  </div>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent transition"
                  placeholder="000000"
                />
                <button
                  type="submit"
                  disabled={loading || code.length < 6}
                  className="mt-4 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Verifying…" : "Enable Two-Factor Auth"}
                </button>
              </form>
            </>
          ) : (
            <div className="text-sm text-red-600 text-center py-4">{error || "Failed to initialize MFA setup."}</div>
          )}
        </div>
      </div>
    </div>
  );
}
