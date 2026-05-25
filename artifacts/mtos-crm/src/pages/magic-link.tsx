import { useEffect, useRef, useState, type FormEvent } from "react";
import { useForceLightSkin } from "@/hooks/use-force-light-skin";
import { Link, useLocation } from "wouter";
import { Loader2, MailCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";

type State =
  | { kind: "verifying" }
  | { kind: "mfa" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  return t && t.trim().length > 0 ? t.trim() : null;
}

export default function MagicLinkPage() {
  useForceLightSkin();
  const { loginWithMagicLink, status } = useAuth();
  const [, navigate] = useLocation();
  const [state, setState] = useState<State>({ kind: "verifying" });
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The initial exchange must fire exactly once — React strict-mode double
  // invoke or a fast-refresh remount would otherwise re-POST the token.
  const fired = useRef(false);

  useEffect(() => {
    document.title = "Signing in · MTOS";
  }, []);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const t = readToken();
    if (!t) {
      setState({
        kind: "error",
        message:
          "This link is missing its sign-in token. Open the link from your email exactly as it appears.",
      });
      return;
    }
    setToken(t);
    void (async () => {
      const result = await loginWithMagicLink(t);
      if (result.kind === "ok") {
        setState({ kind: "success" });
      } else if (result.kind === "mfa_required") {
        setState({ kind: "mfa" });
      } else {
        setState({ kind: "error", message: result.message });
      }
    })();
  }, [loginWithMagicLink]);

  // Once authed, the AuthProvider loads /me — forward to the dashboard.
  useEffect(() => {
    if (state.kind === "success" && status === "authed") {
      const t = setTimeout(() => navigate("/", { replace: true }), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state.kind, status, navigate]);

  const onMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMfaError(null);
    if (!token) return;
    if (!/^\d{6}$/.test(code)) {
      setMfaError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await loginWithMagicLink(token, code);
      if (result.kind === "ok") {
        setState({ kind: "success" });
        return;
      }
      if (result.kind === "mfa_required") {
        setMfaError("That code was not accepted. Please try again.");
        return;
      }
      setMfaError(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === "verifying") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <span>Signing you in…</span>
        </div>
      </div>
    );
  }

  if (state.kind === "mfa") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4 py-10">
        <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-lg">
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="mt-3 text-xl font-semibold text-foreground">One more step</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the 6-digit code from your authenticator app to finish signing in.
            </p>
          </div>
          {mfaError && (
            <div
              role="alert"
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {mfaError}
            </div>
          )}
          <form onSubmit={onMfaSubmit} className="mt-5 space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="magic-totp">Authenticator code</Label>
              <Input
                id="magic-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                disabled={submitting}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? "Verifying…" : "Verify & sign in"}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4 py-10">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <MailCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Signed in</h1>
            <p className="text-sm text-muted-foreground" data-testid="magic-link-success">
              Taking you to your dashboard…
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Sign-in link problem</h1>
          <p className="text-sm text-muted-foreground" data-testid="magic-link-error">
            {state.message}
          </p>
        </div>
        <Button asChild className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </div>
  );
}
