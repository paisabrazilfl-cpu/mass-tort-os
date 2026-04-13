import { useGetDashboardStats, useGetPipelineBreakdown, useGetRecentActivity, useGetParalegalLeaderboard, getGetDashboardStatsQueryKey, getGetPipelineBreakdownQueryKey, getGetRecentActivityQueryKey, getGetParalegalLeaderboardQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, DollarSign, Users, CheckCircle, Percent, Flame } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() }
  });
  const { data: pipeline, isLoading: pipelineLoading } = useGetPipelineBreakdown({
    query: { queryKey: getGetPipelineBreakdownQueryKey() }
  });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({
    query: { queryKey: getGetRecentActivityQueryKey() }
  });
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetParalegalLeaderboard({
    query: { queryKey: getGetParalegalLeaderboardQueryKey() }
  });

  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Command Center</h1>
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-green-500"></span>
          <span className="text-sm text-muted-foreground font-mono">SYSTEM ONLINE</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          title="Total Claimants"
          value={stats?.total_leads}
          icon={Users}
          loading={statsLoading}
        />
        <StatCard
          title="Hot Leads"
          value={stats?.new_leads}
          icon={Flame}
          loading={statsLoading}
        />
        <StatCard
          title="Qualified"
          value={stats?.qualified_leads}
          icon={CheckCircle}
          loading={statsLoading}
        />
        <StatCard
          title="Signed Retainers"
          value={stats?.signed_retainers}
          icon={FileTextIcon}
          loading={statsLoading}
        />
        <StatCard
          title="CPSR"
          value={stats?.cpsr ? `$${stats.cpsr.toFixed(2)}` : 'N/A'}
          icon={DollarSign}
          loading={statsLoading}
        />
        <StatCard
          title="ROI %"
          value={stats?.conversion_rate ? `${stats.conversion_rate.toFixed(1)}%` : 'N/A'}
          icon={Percent}
          loading={statsLoading}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline Status</CardTitle>
          </CardHeader>
          <CardContent>
            {pipelineLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pipeline?.by_status || []}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      fill="#8884d8"
                      paddingAngle={5}
                      dataKey="count"
                      nameKey="status"
                    >
                      {(pipeline?.by_status || []).map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle>Cases by Tort Type</CardTitle>
          </CardHeader>
          <CardContent>
            {pipelineLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pipeline?.by_tort_type || []}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="tort_type" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <RechartsTooltip 
                      cursor={{fill: 'hsl(var(--muted))'}}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                    />
                    <Legend />
                    <Bar dataKey="qualified" stackId="a" fill="hsl(var(--chart-2))" name="Qualified" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="signed" stackId="a" fill="hsl(var(--chart-1))" name="Signed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Paralegal Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            {leaderboardLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
                    <tr>
                      <th className="px-4 py-3">Rank</th>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Signed</th>
                      <th className="px-4 py-3">Qualified</th>
                      <th className="px-4 py-3">Conv Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(leaderboard || []).slice(0, 4).map((row, idx) => (
                      <tr key={row.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                        <td className="px-4 py-3 font-medium">#{idx + 1}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.name}</div>
                          <div className="text-xs text-muted-foreground">{row.role}</div>
                        </td>
                        <td className="px-4 py-3 font-bold text-primary">{row.signed}</td>
                        <td className="px-4 py-3">{row.qualified}</td>
                        <td className="px-4 py-3">{row.conversion_rate.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activityLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                {activity?.map((item) => (
                  <div key={item.id} className="flex items-start gap-4 text-sm">
                    <div className="mt-0.5 rounded-full bg-primary/10 p-1.5 flex-shrink-0">
                      <Activity className="h-3 w-3 text-primary" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="font-medium leading-none">{item.lead_name}</p>
                      <p className="text-muted-foreground">{item.description}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {format(new Date(item.occurred_at), "MMM d, h:mm a")}
                      </p>
                    </div>
                  </div>
                ))}
                {(!activity || activity.length === 0) && (
                  <p className="text-sm text-muted-foreground text-center py-4">No recent activity.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, loading }: { title: string; value?: number | string; icon: any; loading: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-2xl font-bold">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  );
}

function FileTextIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}