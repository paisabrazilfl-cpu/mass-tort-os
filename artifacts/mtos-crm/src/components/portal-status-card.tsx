import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ShieldCheck, ShieldAlert, ShieldOff, RefreshCw, Send,
  CheckCircle, XCircle, Clock, Eye
} from "lucide-react";

interface PortalUser {
  id: number;
  email: string;
  name: string;
  email_verified: boolean;
  mfa_enabled: boolean;
  mfa_verified: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface AuditEntry {
  action: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

interface PortalStatus {
  portal_user: PortalUser | null;
  recent_audit: AuditEntry[];
}

function friendlyAction(action: string): string {
  const map: Record<string, string> = {
    "portal.login":          "Signed in",
    "portal.login_failed":   "Failed login attempt",
    "portal.logout":         "Signed out",
    "portal.signup_complete":"Account created",
    "portal.email_verified": "Email verified",
    "portal.mfa_setup":      "MFA setup started",
    "portal.mfa_verified":   "MFA enabled",
    "portal.view_case":      "Viewed case status",
    "portal.view_document":  "Viewed documents",
    "portal.view_records":   "Viewed medical records",
    "portal.invite_sent":    "Invite sent",
  };
  return map[action] ?? action;
}

function StatusPill({ user }: { user: PortalUser | null }) {
  if (!user) {
    return (
      <Badge variant="outline" className="gap-1 text-slate-500">
        <ShieldOff className="h-3 w-3" />
        Not invited
      </Badge>
    );
  }
  if (user.mfa_enabled && user.email_verified) {
    return (
      <Badge className="gap-1 bg-green-600 hover:bg-green-700">
        <ShieldCheck className="h-3 w-3" />
        Active
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
      <ShieldAlert className="h-3 w-3" />
      Pending setup
    </Badge>
  );
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      {ok
        ? <CheckCircle className="h-3.5 w-3.5 text-green-500" />
        : <XCircle className="h-3.5 w-3.5 text-slate-300" />
      }
    </div>
  );
}

interface Props {
  leadId: number;
}

export function PortalStatusCard({ leadId }: Props) {
  const { toast } = useToast();
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState(false);
  const [impersonating, setImpersonating] = useState(false);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await apiFetchRaw(`/api/leads/${leadId}/portal-status`);
      if (res.ok) {
        const data = await res.json() as PortalStatus;
        setStatus(data);
      }
    } catch {
      /* silently skip — portal is additive */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadStatus(); }, [leadId]);

  async function handleImpersonate() {
    setImpersonating(true);
    try {
      const res = await apiFetchRaw(`/api/leads/${leadId}/portal-impersonate`, { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { portal_url: string; portal_user: { name: string } };
        window.open(data.portal_url, "_blank", "noopener,noreferrer");
        toast({ title: `Viewing portal as ${data.portal_user.name}`, description: "Session expires in 10 minutes. All activity is audited." });
      } else {
        const err = await res.json().catch(() => ({ message: "Impersonation failed" })) as { message?: string };
        toast({ title: err.message || "Failed to open portal view", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to open portal view", variant: "destructive" });
    } finally {
      setImpersonating(false);
    }
  }

  async function handleResend() {
    setResending(true);
    try {
      const res = await apiFetchRaw(`/api/leads/${leadId}/resend-portal-invite`, { method: "POST" });
      if (res.ok) {
        toast({ title: "Portal invite sent", description: "The client will receive an email with their signup link." });
        // Reload to pick up the new invite_sent audit entry after a short delay.
        setTimeout(() => void loadStatus(), 1500);
      } else {
        toast({ title: "Failed to send invite", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to send invite", variant: "destructive" });
    } finally {
      setResending(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" />
            Client Portal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const user = status?.portal_user ?? null;
  const audit = status?.recent_audit ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" />
            Client Portal
          </CardTitle>
          <CardDescription className="mt-0.5">
            Secure portal access for this claimant
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill user={user} />
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void loadStatus()} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {user ? (
          <>
            {/* Account details */}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Account</p>
              <div className="text-sm font-medium">{user.name}</div>
              <div className="text-xs text-muted-foreground">{user.email}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Invited {format(new Date(user.created_at), "MMM d, yyyy")}
              </div>
              {user.last_login_at && (
                <div className="text-xs text-muted-foreground">
                  Last sign-in {format(new Date(user.last_login_at), "MMM d, yyyy 'at' h:mm a")}
                </div>
              )}
            </div>

            {/* Setup checklist */}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Setup</p>
              <CheckRow label="Email verified" ok={user.email_verified} />
              <CheckRow label="Password created" ok={true} />
              <CheckRow label="MFA enabled" ok={user.mfa_enabled} />
              <CheckRow label="MFA verified" ok={user.mfa_verified} />
            </div>

            {/* Recent activity */}
            {audit.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Recent Activity</p>
                <div className="space-y-1">
                  {audit.slice(0, 5).map((entry, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Clock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        <span className="text-xs text-foreground truncate">{friendlyAction(entry.action)}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {format(new Date(entry.created_at), "MMM d, h:mm a")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Admin actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={() => void handleImpersonate()}
                disabled={impersonating}
                title="Open the portal as this client (10-min session, fully audited)"
              >
                <Eye className="h-3.5 w-3.5" />
                {impersonating ? "Opening…" : "View as Client"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={() => void handleResend()}
                disabled={resending}
              >
                <Send className="h-3.5 w-3.5" />
                {resending ? "Sending…" : "Resend Invite"}
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center py-2">
            <ShieldOff className="h-7 w-7 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No portal account yet</p>
            <p className="text-xs text-muted-foreground mt-0.5 mb-3">
              An invite is sent automatically when the background check passes.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => void handleResend()}
              disabled={resending}
            >
              <Send className="h-3.5 w-3.5" />
              {resending ? "Sending…" : "Send Portal Invite Now"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
