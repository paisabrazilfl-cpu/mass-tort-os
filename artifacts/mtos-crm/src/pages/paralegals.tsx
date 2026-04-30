import { useState } from "react";
import {
  useListParalegals,
  useCreateParalegal,
  useDeleteParalegal,
  useGetParalegalLeaderboard,
  getListParalegalsQueryKey,
  getGetParalegalLeaderboardQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

const PARALEGAL_ROLES = [
  "Paralegal",
  "Senior Paralegal",
  "Lead Paralegal",
  "Intake Specialist",
  "Case Manager",
] as const;

type ParalegalRole = (typeof PARALEGAL_ROLES)[number];

interface ParalegalRow {
  id: number;
  name: string;
  role: string;
  total_assigned: number;
  signed_cases: number;
}

export default function Paralegals() {
  const { data: paralegals, isLoading: paralegalsLoading } = useListParalegals({
    query: { queryKey: getListParalegalsQueryKey() },
  });

  const { data: leaderboard, isLoading: leaderboardLoading } = useGetParalegalLeaderboard({
    query: { queryKey: getGetParalegalLeaderboardQueryKey() },
  });

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newParalegal, setNewParalegal] = useState<{
    name: string;
    email: string;
    role: ParalegalRole;
  }>({ name: "", email: "", role: "Paralegal" });

  const [deleteTarget, setDeleteTarget] = useState<ParalegalRow | null>(null);

  const createParalegal = useCreateParalegal();
  const deleteParalegal = useDeleteParalegal();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: getListParalegalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetParalegalLeaderboardQueryKey() });
  };

  const handleAddParalegal = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createParalegal.mutateAsync({ data: newParalegal });
      toast({ title: "Paralegal added successfully" });
      setIsAddOpen(false);
      setNewParalegal({ name: "", email: "", role: "Paralegal" });
      invalidateLists();
    } catch {
      toast({ title: "Failed to add paralegal", variant: "destructive" });
    }
  };

  const handleDeleteParalegal = async () => {
    if (!deleteTarget) return;
    try {
      const result = await deleteParalegal.mutateAsync({ id: deleteTarget.id });
      const unassigned = (result as { leads_unassigned?: number }).leads_unassigned ?? 0;
      toast({
        title: `${deleteTarget.name} removed`,
        description:
          unassigned > 0
            ? `${unassigned} lead${unassigned === 1 ? "" : "s"} unassigned.`
            : "No leads were assigned to this paralegal.",
      });
      setDeleteTarget(null);
      invalidateLists();
    } catch {
      toast({ title: "Failed to delete paralegal", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Paralegal Management</h1>

        {/* Add Paralegal */}
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Paralegal
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Paralegal</DialogTitle>
              <DialogDescription>
                Create a paralegal record so cases and tasks can be assigned to this team member.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleAddParalegal} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  required
                  value={newParalegal.name}
                  onChange={(e) => setNewParalegal({ ...newParalegal, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={newParalegal.email}
                  onChange={(e) => setNewParalegal({ ...newParalegal, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select
                  value={newParalegal.role}
                  onValueChange={(v) =>
                    setNewParalegal({ ...newParalegal, role: v as ParalegalRole })
                  }
                >
                  <SelectTrigger id="role">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {PARALEGAL_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createParalegal.isPending}>
                  {createParalegal.isPending ? "Adding…" : "Add Paralegal"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Paralegal cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {paralegalsLoading ? (
          <>
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </>
        ) : (
          (paralegals || []).map((paralegal) => {
            const row = leaderboard?.find((r) => r.id === paralegal.id);
            const convRate = row?.conversion_rate || 0;
            return (
              <Card key={paralegal.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                        <User className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate">{paralegal.name}</CardTitle>
                        <div className="text-xs text-muted-foreground truncate">{paralegal.role}</div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(paralegal as ParalegalRow)}
                      title={`Delete ${paralegal.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div className="text-muted-foreground">Assigned</div>
                      <div className="font-medium text-lg">{paralegal.total_assigned}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Signed</div>
                      <div className="font-medium text-lg text-primary">{paralegal.signed_cases}</div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Conversion</span>
                      <span className="font-medium">{convRate.toFixed(1)}%</span>
                    </div>
                    <Progress value={convRate} className="h-2" />
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
        {!paralegalsLoading && (paralegals || []).length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            No paralegals yet. Add one to get started.
          </div>
        )}
      </div>

      {/* Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {leaderboardLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
                  <tr>
                    <th className="px-4 py-3 w-16">Rank</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3 text-right">Assigned</th>
                    <th className="px-4 py-3 text-right">Qualified</th>
                    <th className="px-4 py-3 text-right">Signed</th>
                    <th className="px-4 py-3 text-right">Rejected</th>
                    <th className="px-4 py-3 text-right">Conv Rate</th>
                    <th className="px-4 py-3 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {(leaderboard || []).map((row, idx) => (
                    <tr
                      key={row.id}
                      className={`border-b last:border-0 hover:bg-muted/50 transition-colors ${idx === 0 ? "bg-primary/5" : ""}`}
                    >
                      <td className="px-4 py-3 font-medium">#{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{row.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.role}</td>
                      <td className="px-4 py-3 text-right">{row.total_assigned}</td>
                      <td className="px-4 py-3 text-right">{row.qualified}</td>
                      <td className="px-4 py-3 text-right font-bold text-primary">{row.signed}</td>
                      <td className="px-4 py-3 text-right text-destructive">{row.rejected}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        {row.conversion_rate.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            const p = (paralegals || []).find((pp) => pp.id === row.id);
                            if (p) setDeleteTarget(p as ParalegalRow);
                          }}
                          title={`Delete ${row.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(!leaderboard || leaderboard.length === 0) && (
                <div className="text-center py-6 text-muted-foreground">No data available.</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This will permanently remove this paralegal.
              {(deleteTarget?.total_assigned ?? 0) > 0 && (
                <span className="block mt-1 text-amber-600 dark:text-amber-400 font-medium">
                  {deleteTarget!.total_assigned} lead
                  {deleteTarget!.total_assigned === 1 ? "" : "s"} will be unassigned.
                </span>
              )}
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteParalegal.isPending}
              onClick={handleDeleteParalegal}
            >
              {deleteParalegal.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
