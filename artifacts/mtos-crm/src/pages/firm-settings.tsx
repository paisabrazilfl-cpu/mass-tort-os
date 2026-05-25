import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { format } from "date-fns";
import {
  Building2,
  Check,
  Copy,
  Loader2,
  Mail,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";

// Server contract is the inverse of the register page: GET returns
// invite metadata only (no plaintext token), POST returns the plaintext
// token EXACTLY ONCE so the admin can build the share link. We mirror
// that lifecycle in component state — once a freshly-minted token is
// dismissed it is gone, exactly like an SSH key.
type InviteRow = {
  id: number;
  email_prefill: string | null;
  expires_at: string;
  claimed_by_user_id: number | null;
  claimed_at: string | null;
  created_by_user_id: number;
  created_at: string;
  status: "pending" | "claimed" | "expired";
};

type CreatedInvite = {
  id: number;
  token: string;
  expires_at: string;
  email_prefill: string | null;
  link: string;
};

function buildInviteLink(token: string): string {
  // BASE_URL already includes a trailing slash (e.g. "/" for the root
  // artifact, or "/mtos-crm/" if path-mounted). Strip it before joining
  // so we always produce a single "/register?invite=..." segment.
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, "");
  return `${base}/register?invite=${token}`;
}

const STATUS_BADGE: Record<InviteRow["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-blue-100 text-blue-800" },
  claimed: { label: "Claimed", className: "bg-emerald-100 text-emerald-800" },
  expired: { label: "Expired", className: "bg-muted text-muted-foreground" },
};

export default function FirmSettings() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [emailPrefill, setEmailPrefill] = useState("");
  const [latest, setLatest] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Firm Settings · MTOS";
  }, []);

  const loadInvites = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetchRaw("/api/auth/firm-invites");
      if (!res.ok) {
        if (res.status === 403) {
          setLoadError("You need an admin role to view firm invites.");
          setInvites([]);
          return;
        }
        setLoadError("Could not load invites. Please try again.");
        return;
      }
      const body = (await res.json()) as { invites: InviteRow[] };
      setInvites(body.invites);
    } catch {
      setLoadError("Network error — please retry.");
    }
  }, []);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCopied(false);
    try {
      const res = await apiFetchRaw("/api/auth/firm-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_prefill: emailPrefill.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        toast({
          title: "Could not create invite",
          description:
            body.error || body.message || `Server returned ${res.status}.`,
          variant: "destructive",
        });
        return;
      }
      const body = (await res.json()) as {
        id: number;
        token: string;
        expires_at: string;
        email_prefill: string | null;
      };
      const link = buildInviteLink(body.token);
      setLatest({ ...body, link });
      setEmailPrefill("");
      // Optimistically refresh the list so the new row shows immediately.
      await loadInvites();
    } catch {
      toast({
        title: "Network error",
        description: "Could not reach the server. Please retry.",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!latest) return;
    try {
      await navigator.clipboard.writeText(latest.link);
      setCopied(true);
      toast({
        title: "Invite link copied",
        description: "Share it with your teammate. The link works once.",
      });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the link manually and copy it.",
        variant: "destructive",
      });
    }
  };

  const sortedInvites = useMemo(() => {
    if (!invites) return null;
    return [...invites].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [invites]);

  return (
    <div className="space-y-6 p-6" data-testid="firm-settings-page">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">Firm Settings</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Invite teammates to your firm. They'll register through a one-time
          link and join your firm automatically — no admin shuffling required.
        </p>
      </header>

      <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Invite a teammate
              </CardTitle>
              <CardDescription>
                Generate a one-time link that binds the new account to your
                firm. The link expires in 14 days. You can optionally prefill
                the recipient's email.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={onCreate}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                data-testid="firm-settings-create-form"
              >
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="invite-email">Email (optional)</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="teammate@example.com"
                    value={emailPrefill}
                    onChange={(e) => setEmailPrefill(e.target.value)}
                    autoComplete="off"
                    disabled={creating}
                    data-testid="firm-settings-email-input"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={creating}
                  data-testid="firm-settings-create-btn"
                >
                  {creating && (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {creating ? "Creating…" : "Create invite link"}
                </Button>
              </form>

              {latest && (
                <div
                  className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3"
                  data-testid="firm-settings-latest-invite"
                >
                  <p className="text-xs font-medium text-foreground">
                    New invite link — copy it now
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    This link is shown only once and can only be used to
                    register a single account. It expires{" "}
                    {format(new Date(latest.expires_at), "PPp")}.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      readOnly
                      value={latest.link}
                      className="font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                      data-testid="firm-settings-invite-link-input"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={copyLink}
                      data-testid="firm-settings-copy-btn"
                    >
                      {copied ? (
                        <Check
                          className="mr-1.5 h-4 w-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <Copy
                          className="mr-1.5 h-4 w-4"
                          aria-hidden="true"
                        />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outstanding invites</CardTitle>
              <CardDescription>
                Status reflects the live state of each invite. Tokens are never
                shown again after the moment of creation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadError && (
                <div
                  role="alert"
                  className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {loadError}
                </div>
              )}
              {sortedInvites === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : sortedInvites.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="firm-settings-empty"
                >
                  No invites yet. Create one above to get started.
                </p>
              ) : (
                <Table data-testid="firm-settings-invite-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>Claimed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedInvites.map((row) => {
                      const badge = STATUS_BADGE[row.status];
                      return (
                        <TableRow key={row.id}>
                          <TableCell>
                            {row.email_prefill ? (
                              <span className="flex items-center gap-1.5 text-sm">
                                <Mail
                                  className="h-3.5 w-3.5 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                {row.email_prefill}
                              </span>
                            ) : (
                              <span className="text-xs italic text-muted-foreground">
                                no prefill
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge className={badge.className} variant="secondary">
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {format(new Date(row.created_at), "PPp")}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {format(new Date(row.expires_at), "PPp")}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row.claimed_at
                              ? format(new Date(row.claimed_at), "PPp")
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
    </div>
  );
}
