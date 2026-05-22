import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Users,
  UserPlus,
  Mail,
  Trash2,
  Loader2,
  Copy,
  Send,
  RefreshCw,
  Infinity as InfinityIcon,
} from "lucide-react";
import { format } from "date-fns";
import { apiFetchRaw } from "@/lib/api-fetch";

interface Member {
  id: number;
  email: string;
  name: string;
  role: string;
  mfa_enabled: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
}

interface Invite {
  id: number;
  email_prefill: string | null;
  expires_at: string;
  claimed_at: string | null;
  created_at: string;
  status: string; // "pending" | "claimed" | "expired"
}

/** The link + delivery status surfaced after an invite is minted. */
interface LastInvite {
  email: string;
  link: string;
  emailSent: boolean;
}

const roleColor: Record<string, string> = {
  super_admin: "bg-violet-600 text-white",
  admin: "bg-blue-600 text-white",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function inviteLink(token: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://mtosvelocity.com";
  return `${origin}/register?invite=${encodeURIComponent(token)}`;
}

/** mailto: link so the inviter can deliver the invite from their own email. */
function mailtoHref(li: LastInvite): string {
  const subject = "Your invitation to Mass Tort OS";
  const body =
    `You've been invited to join the team on Mass Tort OS.\n\n` +
    `Set up your account here — this email address will be your sign-in:\n\n${li.link}\n\n` +
    `The link expires in 14 days.`;
  return `mailto:${encodeURIComponent(li.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function CompanyTeams() {
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<LastInvite | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [mRes, iRes] = await Promise.all([
        apiFetchRaw("/api/auth/users"),
        apiFetchRaw("/api/auth/firm-invites"),
      ]);
      if (mRes.ok) {
        const m = await mRes.json();
        setMembers(Array.isArray(m) ? m : []);
      }
      if (iRes.ok) {
        const i = await iRes.json();
        setInvites(Array.isArray(i?.invites) ? i.invites : []);
      }
    } catch {
      toast({ title: "Couldn't load your team", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const sendInvite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      toast({ title: "Enter a valid email address", variant: "destructive" });
      return;
    }
    setInviting(true);
    try {
      const res = await apiFetchRaw("/api/auth/firm-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_prefill: email }),
      });
      const b = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        token?: string;
        email_sent?: boolean;
      };
      if (!res.ok || !b.token) {
        toast({
          title: "Couldn't send invite",
          description: b.error || b.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }
      // Always surface the link — the internal email is best-effort; this
      // panel is the reliable fallback (copy it, or send from your own email).
      setLastInvite({ email, link: inviteLink(b.token), emailSent: Boolean(b.email_sent) });
      toast({
        title: "Invitation created",
        description: b.email_sent
          ? `Emailed to ${email}. Use the panel above to also send it yourself.`
          : `Email delivery failed — copy the link above and send it yourself.`,
      });
      setInviteEmail("");
      fetchAll();
    } catch {
      toast({ title: "Couldn't send invite", variant: "destructive" });
    } finally {
      setInviting(false);
    }
  };

  // Re-issue an invite: mint a fresh token (so we can surface a usable
  // link), surface it, then revoke the old row so one email = one invite.
  const resendInvite = async (inv: Invite) => {
    const email = inv.email_prefill;
    if (!email) {
      toast({ title: "This invite has no email to resend to", variant: "destructive" });
      return;
    }
    setResendingId(inv.id);
    try {
      const res = await apiFetchRaw("/api/auth/firm-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_prefill: email }),
      });
      const b = (await res.json().catch(() => ({}))) as { token?: string; email_sent?: boolean };
      if (!res.ok || !b.token) {
        toast({ title: "Couldn't refresh the invite", variant: "destructive" });
        return;
      }
      setLastInvite({ email, link: inviteLink(b.token), emailSent: Boolean(b.email_sent) });
      // Drop the stale invite so the list shows one pending row per email.
      await apiFetchRaw(`/api/auth/firm-invites/${inv.id}`, { method: "DELETE" }).catch(() => {});
      toast({ title: "Fresh invite ready", description: "Use the link panel above to send it." });
      fetchAll();
    } catch {
      toast({ title: "Couldn't refresh the invite", variant: "destructive" });
    } finally {
      setResendingId(null);
    }
  };

  const revokeInvite = async (id: number) => {
    try {
      const res = await apiFetchRaw(`/api/auth/firm-invites/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast({ title: "Couldn't revoke invite", variant: "destructive" });
        return;
      }
      toast({ title: "Invite revoked" });
      fetchAll();
    } catch {
      toast({ title: "Couldn't revoke invite", variant: "destructive" });
    }
  };

  const copyLink = async () => {
    if (!lastInvite) return;
    try {
      await navigator.clipboard.writeText(lastInvite.link);
      toast({ title: "Link copied", description: "Paste it into any email or message." });
    } catch {
      toast({ title: "Couldn't copy — select the link and copy it manually", variant: "destructive" });
    }
  };

  const pendingInvites = invites.filter((i) => i.status === "pending");

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Your Company Teams</h1>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-24" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your Company Teams</h1>
          <p className="text-sm text-muted-foreground">
            Invite your team by email. The address you invite becomes their sign-in login.
          </p>
        </div>
        <Badge variant="outline" className="flex items-center gap-1 px-3 py-1 text-sm">
          <InfinityIcon className="h-4 w-4" />
          Unlimited seats
        </Badge>
      </div>

      {/* Invite ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite a team member
          </CardTitle>
          <CardDescription>
            We'll email them an invitation. The email address you enter here is the one they'll
            sign in with — it's locked at signup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <Label htmlFor="invite-email">Team member's email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@yourfirm.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendInvite();
                }}
                disabled={inviting}
              />
            </div>
            <Button onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Mail className="mr-2 h-4 w-4" />
              )}
              {inviting ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Redundancy: shareable link — copy it, or send from your own email ─ */}
      {lastInvite && (
        <Card className={lastInvite.emailSent ? "border-primary/40" : "border-amber-500/70"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Invitation link for {lastInvite.email}
            </CardTitle>
            <CardDescription>
              {lastInvite.emailSent
                ? "We emailed this invite. Email delivery is best-effort — if it doesn't arrive, send the link yourself below."
                : "Our email system could not deliver this invite. Copy the link or send it from your own email to get them in."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                value={lastInvite.link}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button variant="outline" onClick={copyLink} className="shrink-0">
                <Copy className="mr-2 h-4 w-4" />
                Copy link
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={mailtoHref(lastInvite)}>
                  <Mail className="mr-2 h-4 w-4" />
                  Send from my email
                </a>
              </Button>
              <Button variant="ghost" onClick={() => setLastInvite(null)}>
                Dismiss
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              "Send from my email" opens your own mail app (Gmail, Outlook, Apple Mail…) with the
              invite ready to send — a reliable backup whenever the built-in email is down.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Team members ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Team members ({members.length})
          </CardTitle>
          <CardDescription>Everyone with an account in your company.</CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              <Users className="mx-auto mb-2 h-10 w-10 opacity-40" />
              <div className="font-medium">No team members yet</div>
              <div className="text-sm">Invite your first teammate above.</div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email (login)</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.name}</TableCell>
                    <TableCell className="font-mono text-sm">{m.email}</TableCell>
                    <TableCell>
                      <Badge className={roleColor[m.role] || "bg-slate-500 text-white"}>
                        {m.role.replace(/_/g, " ").toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {m.last_login_at
                        ? format(new Date(m.last_login_at), "yyyy-MM-dd HH:mm")
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.email_verified_at ? "default" : "outline"}>
                        {m.email_verified_at ? "Active" : "Pending"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pending invites ────────────────────────────────────────────────── */}
      {pendingInvites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Pending invitations ({pendingInvites.length})
            </CardTitle>
            <CardDescription>
              Not accepted yet. "Get link" re-issues the invite so you can send it any way you like;
              "revoke" cancels it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvites.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-sm">
                      {inv.email_prefill || "(any address)"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(inv.created_at), "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(inv.expires_at), "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {inv.email_prefill && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resendInvite(inv)}
                            disabled={resendingId === inv.id}
                          >
                            {resendingId === inv.id ? (
                              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1 h-4 w-4" />
                            )}
                            Get link
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => revokeInvite(inv.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
