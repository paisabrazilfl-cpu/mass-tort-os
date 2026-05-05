import { useEffect, useState, type FormEvent } from "react";
import { useForceLightSkin } from "@/hooks/use-force-light-skin";
import { useLocation } from "wouter";
import { ArrowLeft, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useAuth } from "@/contexts/auth-context";

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

export default function LoginMfaPage() {
  useForceLightSkin();
  const { pendingMfa, verifyMfa, cancelMfa } = useAuth();
  const [, navigate] = useLocation();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = "Verify code · MTOS";
  }, []);

  // If the user landed here without a pending MFA challenge (e.g. refreshed
  // the page after the in-memory state was wiped), send them back to /login.
  useEffect(() => {
    if (!pendingMfa) {
      navigate("/login", { replace: true });
    }
  }, [pendingMfa, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length !== 6) {
      setError("Please enter the 6-digit code from your authenticator app.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await verifyMfa(code);
      if (result.kind === "ok") {
        navigate(getNextPath(), { replace: true });
        return;
      }
      if (result.kind === "mfa_required") {
        // Shouldn't happen, but guard anyway.
        setError("Code rejected — please try a fresh code.");
        setCode("");
        return;
      }
      setError(result.message);
      setCode("");
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = () => {
    cancelMfa();
    navigate("/login", { replace: true });
  };

  if (!pendingMfa) return null;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Smartphone className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Two-factor verification</h1>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator for{" "}
            <span className="font-medium text-foreground">{pendingMfa.email}</span>.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="flex justify-center">
            <InputOTP
              maxLength={6}
              value={code}
              onChange={setCode}
              disabled={submitting}
              autoFocus
              aria-label="6-digit verification code"
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }).map((_, i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting || code.length !== 6}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? "Verifying…" : "Verify and continue"}
          </Button>

          <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
