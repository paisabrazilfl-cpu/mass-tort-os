import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Loader2, MailCheck, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";

const PASSWORD_RULES = [
  "At least 12 characters",
  "At least one uppercase letter",
  "At least one lowercase letter",
  "At least one number",
  "At least one special character (e.g. !@#$%)",
];

// Server contract: 64-hex SHA-256 token in `?invite=`. Anything else is
// treated as "no invite" and the registration falls through to the
// default-firm path. We do not echo the token in the UI.
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/i;

type InvitePreview = {
  firm_name: string;
  email_prefill: string | null;
  expires_at: string;
};

type InviteState =
  | { kind: "none" }
  | { kind: "loading"; token: string }
  | { kind: "valid"; token: string; preview: InvitePreview }
  | { kind: "invalid" };

export default function RegisterPage() {
  const { register, status, user } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Parse ?invite=<token> from window.location once. Wouter's useLocation
  // returns only the pathname, so we go to URLSearchParams directly. The
  // token is never echoed into the rendered DOM — only the firm name and
  // email prefill from the lookup endpoint are user-visible.
  const inviteTokenParam = useMemo(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("invite");
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!INVITE_TOKEN_RE.test(trimmed)) return null;
    return trimmed;
  }, []);

  const [invite, setInvite] = useState<InviteState>(
    inviteTokenParam
      ? { kind: "loading", token: inviteTokenParam }
      : { kind: "none" },
  );

  // Resolve the invite token against /api/auth/invite-info. We render
  // the firm name + prefill on success and a soft warning on failure;
  // we deliberately do NOT block the form, so a stale or expired link
  // still falls through to the default-firm signup path (matching the
  // server's behavior when no token is sent).
  useEffect(() => {
    if (!inviteTokenParam) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/auth/invite-info?token=${encodeURIComponent(inviteTokenParam)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setInvite({ kind: "invalid" });
          return;
        }
        const body = (await res.json()) as InvitePreview;
        if (cancelled) return;
        setInvite({ kind: "valid", token: inviteTokenParam, preview: body });
        if (body.email_prefill) {
          setEmail((current) => (current ? current : body.email_prefill ?? ""));
        }
      } catch {
        if (!cancelled) setInvite({ kind: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteTokenParam]);
  // Set when /api/auth/register returns 202 + pending_verification.
  // Renders the post-submit "check your email" panel instead of the form.
  // Survives only as long as this page is mounted — refresh sends the
  // user back to the form (intentional: stale state would lie about
  // whether the email was actually sent).
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Create account · MTOS";
  }, []);

  // If a session is already live (e.g. dev-bypass or returning user),
  // skip the form and land on the dashboard. The check-your-email panel
  // is only shown to anonymous visitors who just submitted.
  useEffect(() => {
    if (status === "authed" && user) {
      navigate("/", { replace: true });
    }
  }, [status, user, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !name.trim() || !password) {
      setError("Email, name, and password are required.");
      return;
    }
    setSubmitting(true);
    try {
      // Whenever ?invite=<token> is syntactically valid (the regex check
      // in inviteTokenParam already enforced 64-hex), always forward it
      // to the backend — the server is the source of truth for whether
      // the invite is still claimable, and silently dropping a token
      // that looked invalid client-side could let a stale preview lookup
      // route the user to the default firm by accident. The backend
      // returns invalid_invite (400) for bad/expired/claimed tokens,
      // which surfaces as a form error rather than a silent fallback.
      const inviteToForward = inviteTokenParam ?? undefined;
      const result = await register(
        email.trim(),
        password,
        name.trim(),
        inviteToForward,
      );
      if (result.kind === "pending_verification") {
        setSubmittedEmail(result.email);
        setPendingMessage(result.message);
        return;
      }
      setError(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading" || (status === "authed" && user)) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (submittedEmail) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MailCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
            <p className="text-sm text-muted-foreground" data-testid="register-pending-message">
              {pendingMessage ??
                "Account created. Check your email for a verification link to finish signing up."}
            </p>
          </div>
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            We sent a verification link to{" "}
            <span className="font-medium text-foreground">{submittedEmail}</span>. Open it to
            activate your account — the link expires in 24 hours.
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Already verified?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Create your MTOS account</h1>
          <p className="text-sm text-muted-foreground">
            Mass Tort OS · Command Center
          </p>
        </div>

        {invite.kind === "loading" && (
          <div
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
            data-testid="register-invite-loading"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Checking your invite link…
          </div>
        )}
        {invite.kind === "valid" && (
          <div
            className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-foreground"
            data-testid="register-invite-banner"
          >
            <Users className="mt-0.5 h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <div className="space-y-0.5">
              <p>
                You're joining{" "}
                <span
                  className="font-semibold"
                  data-testid="register-invite-firm-name"
                >
                  {invite.preview.firm_name}
                </span>
                .
              </p>
              <p className="text-muted-foreground">
                Finish the form below to accept the invite.
              </p>
            </div>
          </div>
        )}
        {invite.kind === "invalid" && (
          <div
            role="alert"
            className="rounded-md border border-amber-400/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            data-testid="register-invite-invalid"
          >
            That invite link is invalid or has expired. Submitting this form
            with the current link won't work — ask an admin to send a fresh
            invite, or remove <code>?invite=…</code> from the URL to create a
            standalone account on the default firm.
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="register-name">Full name</Label>
            <Input
              id="register-name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-email">Email</Label>
            <Input
              id="register-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-password">Password</Label>
            <Input
              id="register-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby="register-password-rules"
            />
            <ul
              id="register-password-rules"
              className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground"
            >
              {PASSWORD_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>

          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Your account starts in viewer mode — ask an admin to elevate it.
          </p>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
