import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useForceLightSkin } from "@/hooks/use-force-light-skin";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Fingerprint, Loader2, Mail, MailCheck, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { toast } from "@/hooks/use-toast";

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

// ── Brand glyphs ────────────────────────────────────────────────────────────
// lucide-react ships no third-party brand marks (trademark policy), so the
// OAuth providers carry compact inline SVGs. They are decorative — the tiles
// are honest "coming soon" until the backend OAuth flows exist.

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M16.37 12.78c.03 3.27 2.87 4.36 2.9 4.37-.02.08-.45 1.55-1.5 3.07-.9 1.31-1.84 2.62-3.32 2.65-1.45.03-1.92-.86-3.58-.86-1.66 0-2.18.83-3.56.89-1.43.05-2.52-1.42-3.43-2.73-1.86-2.69-3.28-7.6-1.37-10.92.95-1.64 2.64-2.69 4.48-2.71 1.4-.03 2.72.94 3.58.94.85 0 2.46-1.16 4.15-.99.71.03 2.69.29 3.97 2.17-.1.07-2.37 1.39-2.34 4.15ZM13.66 3.7c.76-.92 1.27-2.2 1.13-3.48-1.09.05-2.42.73-3.2 1.65-.7.81-1.32 2.12-1.15 3.37 1.22.1 2.46-.62 3.22-1.54Z" />
    </svg>
  );
}
function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.96h-1.52c-1.49 0-1.95.93-1.95 1.87V12h3.32l-.53 3.47h-2.79v8.38A12 12 0 0 0 24 12Z" />
    </svg>
  );
}
function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2Z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5Z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2Z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5Z" />
    </svg>
  );
}
function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#25D366" aria-hidden="true">
      <path d="M12.04 2c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.48 1.34 5L2 22l5.2-1.36a9.9 9.9 0 0 0 4.83 1.23h.01c5.5 0 9.96-4.46 9.96-9.96S17.54 2 12.04 2Zm5.84 14.24c-.25.7-1.44 1.33-1.99 1.36-.53.05-1.04.24-3.5-.73-2.95-1.16-4.84-4.18-4.99-4.37-.15-.2-1.2-1.6-1.2-3.05 0-1.45.76-2.16 1.03-2.46.27-.3.59-.37.79-.37l.57.01c.18 0 .43-.07.67.51.25.6.84 2.06.91 2.21.07.15.12.32.02.52-.1.2-.15.32-.3.5l-.44.51c-.15.15-.3.31-.13.61.17.3.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.35 1.45.3.15.47.12.64-.07.17-.2.74-.86.94-1.16.2-.3.4-.25.67-.15.27.1 1.71.81 2.01.96.3.15.5.22.57.35.07.12.07.72-.18 1.42Z" />
    </svg>
  );
}

type QuickMethod = {
  key: "google" | "apple" | "facebook" | "microsoft" | "email-link" | "text-code" | "passkey" | "whatsapp";
  label: string;
  icon: ReactNode;
};

const QUICK_METHODS: QuickMethod[] = [
  { key: "google", label: "Google", icon: <GoogleIcon /> },
  { key: "apple", label: "Apple", icon: <AppleIcon /> },
  { key: "facebook", label: "Facebook", icon: <FacebookIcon /> },
  { key: "microsoft", label: "Microsoft", icon: <MicrosoftIcon /> },
  { key: "email-link", label: "Email link", icon: <Mail className="h-5 w-5 text-emerald-600" /> },
  { key: "text-code", label: "Text code", icon: <MessageSquare className="h-5 w-5 text-emerald-600" /> },
  { key: "passkey", label: "Passkey", icon: <Fingerprint className="h-5 w-5 text-emerald-600" /> },
  { key: "whatsapp", label: "WhatsApp", icon: <WhatsAppIcon /> },
];

type Mode = "password" | "magic";

export default function LoginPage() {
  useForceLightSkin();
  const { login, requestMagicLink, status, user } = useAuth();
  const [, navigate] = useLocation();

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState<string | null>(null);
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

  const onPasswordSubmit = async (e: FormEvent) => {
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

  const onMagicSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const addr = magicEmail.trim();
    if (!addr) {
      setError("Enter your email address to receive a sign-in link.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await requestMagicLink(addr);
      if (result.ok) {
        setMagicSent(addr);
        return;
      }
      setError(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onQuickMethod = (m: QuickMethod) => {
    setError(null);
    if (m.key === "email-link") {
      setMagicEmail(email.trim());
      setMagicSent(null);
      setMode("magic");
      return;
    }
    // Honest — these have no backend yet. The tile is not a fake success:
    // it tells the truth the moment it is clicked.
    toast({
      title: `${m.label} sign-in is coming soon`,
      description: "Use your email and password, or the email sign-in link, to get in today.",
    });
  };

  const backToPassword = () => {
    setMode("password");
    setMagicSent(null);
    setError(null);
  };

  // While booting, or if we've already detected an authed session and are
  // about to redirect, render a centered spinner instead of the form.
  if (status === "loading" || (status === "authed" && user)) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Signing you in…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-lg">
        <header className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">MTOS CRM</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "magic"
              ? "Sign in with a one-time email link"
              : "Sign in to access your command center"}
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

        {/* ── Magic-link mode ───────────────────────────────────────────── */}
        {mode === "magic" ? (
          magicSent ? (
            <div className="mt-6 space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <MailCheck className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">Check your inbox</h2>
                <p className="text-sm text-muted-foreground">
                  If an account exists for <span className="font-medium text-foreground">{magicSent}</span>,
                  a one-time sign-in link is on its way. It expires in 15 minutes.
                </p>
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={backToPassword}>
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={onMagicSubmit} className="mt-6 space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="magic-email">Email address</Label>
                <Input
                  id="magic-email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@firm.com"
                  required
                  value={magicEmail}
                  onChange={(e) => setMagicEmail(e.target.value)}
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  We'll email you a secure link — no password needed.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitting ? "Sending link…" : "Send sign-in link"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={backToPassword}
                disabled={submitting}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Back to all sign-in options
              </Button>
            </form>
          )
        ) : (
          /* ── Password mode (default) ─────────────────────────────────── */
          <>
            <div className="mt-6">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Quick sign in with
              </p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {QUICK_METHODS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => onQuickMethod(m)}
                    className="flex flex-col items-center gap-1.5 rounded-lg border bg-background px-1 py-3 text-[11px] font-medium text-foreground transition hover:border-primary/50 hover:bg-accent"
                  >
                    {m.icon}
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="my-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                or use your email
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={onPasswordSubmit} className="space-y-4" noValidate>
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
          </>
        )}

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
