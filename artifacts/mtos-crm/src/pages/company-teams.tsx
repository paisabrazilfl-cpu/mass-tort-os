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
import { Users, UserPlus, Mail, Trash2, Loader2, Infinity as InfinityIcon } from "lucide-react";
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

const roleColor: Record<string, string> = {
  super_admin: "bg-violet-600 text-white",
  admin: "bg-blue-600 text-white",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function CompanyTeams() {
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

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
        email_sent?: boolean;
      };
      if (!res.ok) {
        toast({
          title: "Couldn't send invite",
          description: b.error || b.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Invitation sent",
        description: b.email_sent
          ? `${email} will get a sign-in link — that address becomes their login.`
          : `Invite created for ${email}, but the email couldn't be delivered. Check the email integration.`,
      });
      setInviteEmail("");
      fetchAll();
    } catch {
      toast({ title: "Couldn't send invite", variant: "destructive" });
    } finally {
      setInviting(false);
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
              Invites that haven't been accepted yet. Revoke one to cancel it.
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
                      <Button variant="ghost" size="sm" onClick={() => revokeInvite(inv.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
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
