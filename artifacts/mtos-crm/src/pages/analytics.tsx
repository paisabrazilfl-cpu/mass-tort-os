import { useGetAnalyticsOverview, useGetConversionFunnel, useGetTortBreakdown, useGetPipelineTrend, getGetAnalyticsOverviewQueryKey, getGetConversionFunnelQueryKey, getGetTortBreakdownQueryKey, getGetPipelineTrendQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, CheckCircle, Percent, TrendingUp } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace/workspace-hero";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, Legend } from "recharts";
import { format } from "date-fns";

export default function Analytics() {
  const { data: overview, isLoading: overviewLoading } = useGetAnalyticsOverview({
    query: { queryKey: getGetAnalyticsOverviewQueryKey() }
  });
  const { data: funnel, isLoading: funnelLoading } = useGetConversionFunnel({
    query: { queryKey: getGetConversionFunnelQueryKey() }
  });
  const { data: torts, isLoading: tortsLoading } = useGetTortBreakdown({
    query: { queryKey: getGetTortBreakdownQueryKey() }
  });
  const { data: trend, isLoading: trendLoading } = useGetPipelineTrend({
    query: { queryKey: getGetPipelineTrendQueryKey() }
  });

  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

  const scoreData = overview?.analysis ? [
    { name: 'Strong', value: Number(overview.analysis.strong_cases) || 0, color: 'hsl(var(--chart-2))' },
    { name: 'Moderate', value: Number(overview.analysis.moderate_cases) || 0, color: 'hsl(var(--chart-3))' },
    { name: 'Weak', value: Number(overview.analysis.weak_cases) || 0, color: 'hsl(var(--chart-4))' },
    { name: 'Disqualified', value: Number(overview.analysis.disqualified_cases) || 0, color: 'hsl(var(--destructive))' }
  ] : [];

  return (
    <div className="space-y-6">
      <WorkspaceHero
        eyebrow="Intelligence"
        title="Analytics & ROI"
        description="Conversion funnel, pipeline trends, and tort breakdown — everything you need to measure lead acquisition performance at a glance."
        badge="Live data"
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <>
                <div className="text-2xl font-bold">{overview?.leads?.total as React.ReactNode || 0}</div>
                <div className="text-xs text-muted-foreground flex gap-2 mt-1">
                  <span className="text-destructive font-medium">{overview?.leads?.hot as React.ReactNode || 0} Hot</span>
                  <span className="text-orange-500">{overview?.leads?.warm as React.ReactNode || 0} Warm</span>
                  <span>{overview?.leads?.cold as React.ReactNode || 0} Cold</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Qualification Rate</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="text-2xl font-bold">
                {overview?.leads?.qualification_rate ? `${Number(overview.leads.qualification_rate).toFixed(1)}%` : '0%'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="text-2xl font-bold">
                {overview?.leads?.conversion_rate ? `${Number(overview.leads.conversion_rate).toFixed(1)}%` : '0%'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">ROI %</CardTitle>
            <Percent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <>
                <div className="text-2xl font-bold text-primary">
                  {overview?.leads?.roi ? `${Number(overview.leads.roi).toFixed(1)}%` : 'N/A'}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  CPSR: {overview?.leads?.cpsr ? `$${Number(overview.leads.cpsr).toFixed(2)}` : 'N/A'}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversion Funnel</CardTitle>
        </CardHeader>
        <CardContent>
          {funnelLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={funnel || []} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis dataKey="stage" type="category" stroke="hsl(var(--foreground))" fontSize={12} tickLine={false} axisLine={false} width={120} />
                  <Tooltip 
                    cursor={{fill: 'hsl(var(--muted))'}}
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]}>
                    {(funnel || []).map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color || `hsl(var(--chart-${(index % 5) + 1}))`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tort Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {tortsLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={torts || []}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="tort_type" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      cursor={{fill: 'hsl(var(--muted))'}}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                    />
                    <Legend />
                    <Bar dataKey="total" fill="hsl(var(--chart-3))" name="Total Leads" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="signed" fill="hsl(var(--chart-1))" name="Signed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Case Analysis Score Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={scoreData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={5}
                      dataKey="value"
                      nameKey="name"
                    >
                      {scoreData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline Trend</CardTitle>
        </CardHeader>
        <CardContent>
          {trendLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend || []}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="date" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false}
                    tickFormatter={(value) => format(new Date(value), "MMM d")}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                    labelFormatter={(value) => format(new Date(value), "MMM d, yyyy")}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="total" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} name="Total Leads" />
                  <Line type="monotone" dataKey="qualified" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} name="Qualified" />
                  <Line type="monotone" dataKey="signed" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} name="Signed" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CellWrapper(props: any) {
  return <path {...props} />;
}
