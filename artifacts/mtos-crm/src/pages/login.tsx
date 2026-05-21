import { useEffect, useState, type FormEvent } from "react";
import { useForceLightSkin } from "@/hooks/use-force-light-skin";
import { Link, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { AuthBackground } from "@/components/auth/auth-background";

function getNextPath(): string {
  if (typeof window === "undefined") return "/";
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  if (!next) return "/";
  try {
    const decoded = decodeURIComponent(next);
    if (decoded.startsWith("/login")) return "/";
    return decoded;
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  useForceLightSkin();
  const { login, status, user } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = "Sign in · MTOS";
  }, []);

  // If already authed (e.g. dev-bypass), bounce to next.
  useEffect(() => {
    if (status === "authed" && user) {
      navigate(getNextPath(), { replace: true });
    }
  }, [status, user, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result.kind === "ok") {
        navigate(getNextPath(), { replace: true });
        return;
      }
      if (result.kind === "mfa_required") {
        navigate(`/login/mfa?next=${encodeURIComponent(getNextPath())}`, { replace: true });
        return;
      }
      setError(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  // While booting, or if we've already detected an authed session and are
  // about to redirect, render a centered spinner instead of the form.
  if (status === "loading" || (status === "authed" && user)) {
    return (
      <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden">
        <AuthBackground />
        <Loader2 className="h-6 w-6 animate-spin text-white/70" aria-hidden="true" />
        <span className="sr-only">Signing you in…</span>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4 py-10">
      <AuthBackground />
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-card p-8 shadow-2xl ring-1 ring-black/5">
        <header className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">MTOS CRM</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to access your command center
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="login-email">Email address</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder="you@firm.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
            />
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          New to MTOS?{" "}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create account
          </Link>
        </p>
        <p className="mt-1 text-center text-xs text-muted-foreground">
          Trouble signing in? Contact your MTOS administrator.
        </p>
      </div>
    </div>
  );
}
