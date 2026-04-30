import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Loader2, ShieldCheck } from "lucide-react";
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

export default function RegisterPage() {
  const { register, status, user } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = "Create account · MTOS";
  }, []);

  // If a session is already live (e.g. dev-bypass or returning user),
  // skip the form and land on the dashboard.
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
      const result = await register(email.trim(), password, name.trim());
      if (result.kind === "ok") {
        navigate("/", { replace: true });
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
