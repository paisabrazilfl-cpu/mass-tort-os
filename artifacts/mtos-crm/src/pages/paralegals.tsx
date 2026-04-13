import { useState } from "react";
import { useListParalegals, useCreateParalegal, useGetParalegalLeaderboard, getListParalegalsQueryKey, getGetParalegalLeaderboardQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function Paralegals() {
  const { data: paralegals, isLoading: paralegalsLoading } = useListParalegals({
    query: { queryKey: getListParalegalsQueryKey() }
  });
  
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetParalegalLeaderboard({
    query: { queryKey: getGetParalegalLeaderboardQueryKey() }
  });

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newParalegal, setNewParalegal] = useState({ name: "", email: "", role: "" });
  
  const createParalegal = useCreateParalegal();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleAddParalegal = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createParalegal.mutateAsync({ data: newParalegal });
      toast({ title: "Paralegal added successfully" });
      setIsAddOpen(false);
      setNewParalegal({ name: "", email: "", role: "" });
      queryClient.invalidateQueries({ queryKey: getListParalegalsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetParalegalLeaderboardQueryKey() });
    } catch (err) {
      toast({ title: "Failed to add paralegal", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Paralegal Management</h1>
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
            </DialogHeader>
            <form onSubmit={handleAddParalegal} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={newParalegal.name} onChange={e => setNewParalegal({...newParalegal, name: e.target.value})} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={newParalegal.email} onChange={e => setNewParalegal({...newParalegal, email: e.target.value})} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Input id="role" value={newParalegal.role} onChange={e => setNewParalegal({...newParalegal, role: e.target.value})} placeholder="e.g. Senior Paralegal" />
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createParalegal.isPending}>
                  {createParalegal.isPending ? "Adding..." : "Add Paralegal"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

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
            const row = leaderboard?.find(r => r.id === paralegal.id);
            const convRate = row?.conversion_rate || 0;
            return (
              <Card key={paralegal.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <User className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{paralegal.name}</CardTitle>
                      <div className="text-xs text-muted-foreground">{paralegal.role}</div>
                    </div>
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
      </div>

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
                  </tr>
                </thead>
                <tbody>
                  {(leaderboard || []).map((row, idx) => (
                    <tr key={row.id} className={`border-b last:border-0 hover:bg-muted/50 transition-colors ${idx === 0 ? 'bg-primary/5' : ''}`}>
                      <td className="px-4 py-3 font-medium">#{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{row.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.role}</td>
                      <td className="px-4 py-3 text-right">{row.total_assigned}</td>
                      <td className="px-4 py-3 text-right">{row.qualified}</td>
                      <td className="px-4 py-3 text-right font-bold text-primary">{row.signed}</td>
                      <td className="px-4 py-3 text-right text-destructive">{row.rejected}</td>
                      <td className="px-4 py-3 text-right font-medium">{row.conversion_rate.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(!leaderboard || leaderboard.length === 0) && (
                <div className="text-center py-6 text-muted-foreground">
                  No data available.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}