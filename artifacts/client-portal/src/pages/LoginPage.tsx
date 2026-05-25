import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { publicFetch, describeError, ApiError } from "../lib/api";
import { ShieldCheck, Eye, EyeOff } from "lucide-react";

interface LoginResponse {
  // MFA gate — server returns this when mfa_enabled=true but no totp_code was sent.
  mfa_required?: boolean;
  // Success shape
  token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: {
    id: number;
    email: string;
    name: string;
    mfa_verified: boolean;
    mfa_setup_required: boolean; // true when MFA not yet configured
  };
}

export function LoginPage() {
  const { tortSlug, login } = usePortalAuth();
  const [, setLocation] = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [showTotp, setShowTotp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const body: Record<string, string> = { email: email.trim(), password };
      if (showTotp && totp.trim()) body.totp_code = totp.trim();

      const data = await publicFetch<LoginResponse>("/api/portal/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (data.mfa_required) {
        setShowTotp(true);
        setError("Please enter your authenticator code to continue.");
        setLoading(false);
        return;
      }

      if (!data.token || !data.refresh_token || !data.user) {
        setError("Login failed — please try again.");
        setLoading(false);
        return;
      }

      // Store tokens + fetch full /me to populate auth context.
      const me = await login({ token: data.token, refresh_token: data.refresh_token }, data.user.id);

      if (!me?.mfa_enabled) {
        setLocation(`/${tortSlug}/mfa-setup`);
      } else {
        setLocation(`/${tortSlug}/dashboard`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setError("Your account is temporarily locked due to too many failed attempts. Please try again in 30 minutes.");
      } else if (err instanceof ApiError && err.status === 403) {
        setError("Please verify your email address before signing in. Check your inbox for the verification link.");
      } else {
        setError(describeError(err) || "Invalid email or password.");
      }
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo/branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#1e3a5f] mb-4">
            <ShieldCheck className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Client Portal</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to view your case status</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent transition"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="password">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent transition"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(p => !p)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {showTotp && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="totp">
                    Authenticator code
                  </label>
                  <input
                    id="totp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={totp}
                    onChange={e => setTotp(e.target.value.replace(/\D/g, ""))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:border-transparent tracking-widest font-mono transition"
                    placeholder="000000"
                    autoFocus
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Enter the 6-digit code from your authenticator app.
                  </p>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full rounded-lg bg-[#1e3a5f] text-white py-2.5 text-sm font-semibold hover:bg-[#2d5a9e] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Signing in…" : showTotp ? "Verify & Sign In" : "Sign In"}
            </button>
          </form>
        </div>

        {/* HIPAA notice */}
        <p className="text-center text-xs text-slate-400 mt-6 flex items-center justify-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          HIPAA-compliant · 256-bit encrypted · Activity audited
        </p>
      </div>
    </div>
  );
}
