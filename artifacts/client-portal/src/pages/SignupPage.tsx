import { useState, useEffect, type FormEvent } from "react";
import { useSearch, useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { publicFetch, describeError, type ApiError } from "../lib/api";
import { ShieldCheck, Eye, EyeOff, CheckCircle2 } from "lucide-react";

interface SignupResponse {
  message: string;
}

function PasswordRule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? "text-green-600" : "text-slate-400"}`}>
      <CheckCircle2 className={`h-3.5 w-3.5 flex-shrink-0 ${ok ? "text-green-500" : "text-slate-300"}`} />
      {label}
    </li>
  );
}

export function SignupPage() {
  const { tortSlug } = usePortalAuth();
  const search = useSearch();
  const [, setLocation] = useLocation();

  const params = new URLSearchParams(search);
  const token = params.get("token") ?? "";
  const emailParam = params.get("email") ?? "";

  const [email, setEmail] = useState(emailParam);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("This signup link is invalid or has expired. Please contact your case manager.");
    }
  }, [token]);

  const rules = {
    length: password.length >= 12,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    digit: /[0-9]/.test(password),
    match: password.length > 0 && password === confirm,
  };
  const valid = Object.values(rules).every(Boolean);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError("");
    setLoading(true);

    try {
      await publicFetch<SignupResponse>("/api/portal/auth/signup", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      setError(describeError(err as ApiError));
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
          <h1 className="text-xl font-bold text-slate-900">Check your email</h1>
          <p className="text-sm text-slate-500 mt-2">
            We sent a verification link to <strong>{email}</strong>. Click the link to activate your account, then come back to sign in.
          </p>
          <button
            onClick={() => setLocation(`/${tortSlug}/login`)}
            className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] transition-colors"
          >
            Go to Sign In
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
          <h1 className="text-2xl font-bold text-slate-900">Create your account</h1>
          <p className="text-sm text-slate-500 mt-1">Set a password to access your case portal</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="space-y-4">
              {emailParam && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Email address
                  </label>
                  <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {emailParam}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="password">
                  Create a password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent transition"
                    placeholder="••••••••"
                  />
                  <button type="button" onClick={() => setShowPassword(p => !p)} className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600" tabIndex={-1}>
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                {/* Password rules */}
                {password.length > 0 && (
                  <ul className="mt-2 space-y-1 pl-0.5">
                    <PasswordRule ok={rules.length} label="At least 12 characters" />
                    <PasswordRule ok={rules.upper}  label="Uppercase letter" />
                    <PasswordRule ok={rules.lower}  label="Lowercase letter" />
                    <PasswordRule ok={rules.digit}  label="Number" />
                  </ul>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="confirm">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent transition"
                  placeholder="••••••••"
                />
                {confirm.length > 0 && !rules.match && (
                  <p className="mt-1 text-xs text-red-500">Passwords do not match</p>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !valid || !token}
              className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Creating account…" : "Create Account"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6 flex items-center justify-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          HIPAA-compliant · 256-bit encrypted
        </p>
      </div>
    </div>
  );
}
