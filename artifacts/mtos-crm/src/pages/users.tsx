import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, ShieldAlert, ShieldCheck, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useAuth } from "@/contexts/auth-context";

// Mirror of AdminUserRow from artifacts/api-server/src/lib/rbac.ts.
// Kept narrow on purpose — the server already excludes secrets, but we
// also avoid carrying anything we don't render so the UI is impossible
// to use as an exfil vector for fields added later.
type Role = "admin" | "attorney" | "paralegal" | "viewer";
type UserRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  firm_id: number;
  mfa_enabled: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
};

// Admin is deliberately omitted — it cannot be assigned through this
// page. The backend rejects role="admin" on PATCH. Promoting a user to
// admin is a higher-trust operation handled out-of-band so a compromised
// admin token can't mint more admins. Existing admins still display in
// the table (with the red badge) but their role select is unreachable
// (we disable the action button for admin rows).
const ROLE_OPTIONS: { value: Exclude<Role, "admin">; label: string; description: string }[] = [
  { value: "viewer", label: "Viewer", description: "Read-only access. Default for self-serve signups." },
  { value: "paralegal", label: "Paralegal", description: "Can manage leads, cases, and documents." },
  { value: "attorney", label: "Attorney", description: "Full case authority including approvals." },
];

const ROLE_BADGE: Record<Role, string> = {
  admin: "bg-red-100 text-red-800",
  attorney: "bg-purple-100 text-purple-800",
  paralegal: "bg-blue-100 text-blue-800",
  viewer: "bg-muted text-muted-foreground",
};

function formatTs(value: string | null): string {
  if (!value) return "—";
  try {
    return format(new Date(value), "MMM d, yyyy h:mm a");
  } catch {
    return value;
  }
}

export default function Users() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [pendingRole, setPendingRole] = useState<Role>("viewer");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = "Users · MTOS";
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetchRaw("/api/users");
      if (!res.ok) {
        if (res.status === 403) {
          setLoadError("You need an admin role to manage users.");
          setRows([]);
          return;
        }
        setLoadError("Could not load users. Please try again.");
        return;
      }
      const body = (await res.json()) as { status: string; data: { rows: UserRow[] } };
      setRows(body.data.rows);
    } catch {
      setLoadError("Network error — please retry.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setRows([]);
      return;
    }
    void load();
  }, [isAdmin, load]);

  const openEdit = (row: UserRow) => {
    setEditing(row);
    setPendingRole(row.role);
  };

  const onSave = async () => {
    if (!editing) return;
    if (pendingRole === editing.role) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetchRaw(`/api/users/${editing.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: pendingRole }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string } | string;
          message?: string;
        };
        // Server returns either errorEnvelope shape ({error:{message}}) or
        // a flat {message} — handle both.
        const msg =
          (typeof body.error === "object" && body.error?.message) ||
          (typeof body.error === "string" && body.error) ||
          body.message ||
          `Server returned ${res.status}.`;
        toast({ title: "Could not update role", description: msg, variant: "destructive" });
        return;
      }
      toast({
        title: "Role updated",
        description: `${editing.email} is now ${pendingRole}. Their existing sessions have been signed out.`,
      });
      setEditing(null);
      await load();
    } catch {
      toast({
        title: "Network error",
        description: "Could not reach the server. Please retry.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="container max-w-3xl py-10">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
              <CardTitle>Admin only</CardTitle>
            </div>
            <CardDescription>
              You need an admin role to manage users in your firm.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-6xl py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <UserCog className="h-6 w-6" />
          Users
        </h1>
        <p className="text-muted-foreground mt-1">
          Promote new viewers to attorney or paralegal once you've confirmed
          who they are. Changing a role signs the user out of all existing
          sessions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Firm members</CardTitle>
          <CardDescription>
            All users belonging to your firm, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {loadError}
            </div>
          ) : rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Verified</TableHead>
                    <TableHead>MFA</TableHead>
                    <TableHead>Last login</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const isSelf = row.id === user?.id;
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {row.id}
                        </TableCell>
                        <TableCell className="font-medium">
                          {row.name}
                          {isSelf && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>{row.email}</TableCell>
                        <TableCell>
                          <Badge className={ROLE_BADGE[row.role]} variant="secondary">
                            {row.role}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {row.email_verified_at ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                              <ShieldCheck className="h-3.5 w-3.5" /> verified
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">pending</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.mfa_enabled ? (
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">
                              on
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">off</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTs(row.last_login_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTs(row.created_at)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isSelf || row.role === "admin"}
                            title={
                              isSelf
                                ? "You can't change your own role."
                                : row.role === "admin"
                                  ? "Admin role can't be changed from this page."
                                  : "Change role"
                            }
                            onClick={() => openEdit(row)}
                          >
                            Change role
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role for {editing?.email}</DialogTitle>
            <DialogDescription>
              The user's existing browser sessions will be signed out and they'll
              need to log in again to pick up the new role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Select
              value={pendingRole}
              onValueChange={(v) => setPendingRole(v as Role)}
              disabled={saving}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <div className="flex flex-col">
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {opt.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
