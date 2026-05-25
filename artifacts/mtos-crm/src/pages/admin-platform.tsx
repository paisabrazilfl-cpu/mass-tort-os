import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Building2, Users as UsersIcon, ShieldCheck, Activity, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { apiFetchRaw } from "@/lib/api-fetch";

interface PlatformStats {
  total_firms: number;
  total_users: number;
  super_admins: number;
  active_30d: number;
}

interface FirmRow {
  id: number;
  name: string;
  slug: string;
  subscription_status: string;
  current_period_end: string | null;
  created_at: string;
  user_count: number;
  super_admin_count: number;
}

interface PlatformUserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  firm_id: number;
  firm_name: string | null;
  firm_slug: string | null;
  last_login_at: string | null;
  email_verified_at: string | null;
  mfa_enabled: boolean;
  created_at: string;
}

const roleColor: Record<string, string> = {
  super_admin: "bg-violet-600 text-white",
  admin: "bg-blue-600 text-white",
};

const subColor: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  trialing: "bg-blue-500 text-white",
  past_due: "bg-amber-500 text-white",
  canceled: "bg-slate-500 text-white",
  inactive: "bg-slate-400 text-white",
};

export default function AdminPlatform() {
  const { toast } = useToast();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [firms, setFirms] = useState<FirmRow[]>([]);
  const [users, setUsers] = useState<PlatformUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [firmFilter, setFirmFilter] = useState<number | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);

  const loadHeader = useCallback(async () => {
    try {
      const [sRes, fRes] = await Promise.all([
        apiFetchRaw("/api/admin/platform/stats"),
        apiFetchRaw("/api/admin/platform/firms"),
      ]);
      if (sRes.ok) {
        const j = (await sRes.json()) as { status: string; data: PlatformStats };
        setStats(j.data);
      }
      if (fRes.ok) {
        const j = (await fRes.json()) as { status: string; data: { rows: FirmRow[] } };
        setFirms(j.data.rows);
      } else if (fRes.status === 403) {
        toast({
          title: "Restricted",
          description: "Platform admin is for the MTOS operator firm's super-admins only.",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "Couldn't load platform data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const qs = new URLSearchParams();
      if (firmFilter !== null) qs.set("firm_id", String(firmFilter));
      if (search.trim()) qs.set("search", search.trim());
      const url = "/api/admin/platform/users" + (qs.toString() ? `?${qs.toString()}` : "");
      const r = await apiFetchRaw(url);
      if (r.ok) {
        const j = (await r.json()) as { status: string; data: { rows: PlatformUserRow[] } };
        setUsers(j.data.rows);
      }
    } catch {
      toast({ title: "Couldn't load users", variant: "destructive" });
    } finally {
      setUsersLoading(false);
    }
  }, [firmFilter, search, toast]);

  useEffect(() => {
    loadHeader();
  }, [loadHeader]);

  // Debounce the search/filter so we don't hammer the endpoint on every keystroke.
  useEffect(() => {
    const t = setTimeout(loadUsers, 250);
    return () => clearTimeout(t);
  }, [loadUsers]);

  const refresh = () => {
    setLoading(true);
    loadHeader();
    loadUsers();
  };

  const firmName = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of firms) m.set(f.id, f.name);
    return m;
  }, [firms]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Platform Admin</h1>
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16" /></CardContent></Card>
          ))}
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-40" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Platform Admin</h1>
          <p className="text-sm text-muted-foreground">
            Cross-firm view of every user and every firm on this MTOS instance.
          </p>
        </div>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" /> Total firms
            </CardTitle>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.total_firms ?? "—"}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <UsersIcon className="h-4 w-4" /> Total users
            </CardTitle>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.total_users ?? "—"}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Super admins
            </CardTitle>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.super_admins ?? "—"}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" /> Active (30d)
            </CardTitle>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.active_30d ?? "—"}</div></CardContent>
        </Card>
      </div>

      {/* Firms ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Firms ({firms.length})
          </CardTitle>
          <CardDescription>
            Every customer firm on this instance. Click a row to filter the user table below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {firms.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No firms.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead className="text-right">Super admins</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {firms.map((f) => (
                  <TableRow key={f.id} className={firmFilter === f.id ? "bg-muted/50" : undefined}>
                    <TableCell className="font-medium">{f.name}</TableCell>
                    <TableCell className="font-mono text-xs">{f.slug}</TableCell>
                    <TableCell>
                      <Badge className={subColor[f.subscription_status] || "bg-slate-500 text-white"}>
                        {f.subscription_status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{f.user_count}</TableCell>
                    <TableCell className="text-right">{f.super_admin_count}</TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(f.created_at), "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setFirmFilter(firmFilter === f.id ? null : f.id)}
                      >
                        {firmFilter === f.id ? "Clear filter" : "Show users"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Users ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <UsersIcon className="h-5 w-5" /> Users ({users.length})
                {firmFilter !== null && (
                  <Badge variant="outline" className="ml-2">
                    Filtered: {firmName.get(firmFilter) ?? `#${firmFilter}`}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Every user across every firm. Capped at 500; refine with search or firm filter.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search email or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
              {firmFilter !== null && (
                <Button variant="ghost" size="sm" onClick={() => setFirmFilter(null)}>
                  Clear firm filter
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <Skeleton className="h-32" />
          ) : users.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No users match these filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Firm</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell className="font-mono text-sm">{u.email}</TableCell>
                    <TableCell>
                      <Badge className={roleColor[u.role] || "bg-slate-500 text-white"}>
                        {u.role.replace(/_/g, " ").toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{u.firm_name ?? `#${u.firm_id}`}</TableCell>
                    <TableCell className="text-sm">
                      {u.last_login_at
                        ? format(new Date(u.last_login_at), "yyyy-MM-dd HH:mm")
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      {u.mfa_enabled ? (
                        <Badge variant="default">ON</Badge>
                      ) : (
                        <Badge variant="outline">off</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.email_verified_at ? "default" : "outline"}>
                        {u.email_verified_at ? "Yes" : "No"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
