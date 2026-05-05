import { useEffect, useRef, useState } from "react";
import { useForceLightSkin } from "@/hooks/use-force-light-skin";
import { Link, useLocation } from "wouter";
import { Loader2, MailCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";

type VerifyState =
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  return t && t.trim().length > 0 ? t.trim() : null;
}

export default function VerifyEmailPage() {
  useForceLightSkin();
  const { verifyEmail, status } = useAuth();
  const [, navigate] = useLocation();
  const [state, setState] = useState<VerifyState>({ kind: "verifying" });
  // The verify-email endpoint is single-use: a re-fire (e.g. React strict
  // mode's double-invoke or a fast-refresh remount) would consume a token
  // we already swapped for a JWT. Guard with a ref so the network call
  // only ever fires once per mount.
  const fired = useRef(false);

  useEffect(() => {
    document.title = "Verifying email · MTOS";
  }, []);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const token = readToken();
    if (!token) {
      setState({
        kind: "error",
        message:
          "This link is missing its verification token. Please open the link from your email exactly as it appears.",
      });
      return;
    }
    void (async () => {
      const result = await verifyEmail(token);
      if (result.kind === "ok") {
        setState({ kind: "success" });
        return;
      }
      if (result.kind === "mfa_required") {
        // Verification path doesn't issue an MFA challenge — defensive
        // handling for an unexpected shape.
        setState({
          kind: "error",
          message: "Unexpected response. Please sign in to continue.",
        });
        return;
      }
      setState({ kind: "error", message: result.message });
    })();
  }, [verifyEmail]);

  // Once verified the auth context flips to "authed" and the AuthProvider
  // will load /me. Forward to the dashboard as soon as that lands so the
  // success panel doesn't linger.
  useEffect(() => {
    if (state.kind === "success" && status === "authed") {
      const t = setTimeout(() => navigate("/", { replace: true }), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state.kind, status, navigate]);

  if (state.kind === "verifying") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <span>Verifying your email…</span>
        </div>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MailCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Email verified</h1>
            <p className="text-sm text-muted-foreground" data-testid="verify-email-success">
              Your account is ready. Taking you to the dashboard…
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Verification failed</h1>
          <p className="text-sm text-muted-foreground" data-testid="verify-email-error">
            {state.message}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button asChild className="w-full">
            <Link href="/register">Create a new account</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
