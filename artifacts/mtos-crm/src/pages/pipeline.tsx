import { useGetConversionFunnel, useGetPipelineTrend, useGetTortBreakdown, getGetConversionFunnelQueryKey, getGetPipelineTrendQueryKey, getGetTortBreakdownQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from "recharts";
import { format } from "date-fns";

export default function Pipeline() {
  const { data: funnel, isLoading: funnelLoading } = useGetConversionFunnel({
    query: { queryKey: getGetConversionFunnelQueryKey() }
  });
  
  const { data: trend, isLoading: trendLoading } = useGetPipelineTrend({
    query: { queryKey: getGetPipelineTrendQueryKey() }
  });

  const { data: torts, isLoading: tortsLoading } = useGetTortBreakdown({
    query: { queryKey: getGetTortBreakdownQueryKey() }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Pipeline View</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversion Funnel</CardTitle>
        </CardHeader>
        <CardContent>
          {funnelLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <div className="h-[300px] w-full">
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

      <Card>
        <CardHeader>
          <CardTitle>Tort Type Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {tortsLoading ? (
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
                    <th className="px-4 py-3">Tort Type</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">Qualified</th>
                    <th className="px-4 py-3">Signed</th>
                    <th className="px-4 py-3">Rejected</th>
                    <th className="px-4 py-3">Avg Ad Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {(torts || []).map((row, idx) => (
                    <tr key={idx} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="px-4 py-3 font-medium">{row.tort_type}</td>
                      <td className="px-4 py-3">{row.total}</td>
                      <td className="px-4 py-3">{row.qualified}</td>
                      <td className="px-4 py-3 font-bold text-primary">{row.signed}</td>
                      <td className="px-4 py-3 text-destructive">{row.rejected}</td>
                      <td className="px-4 py-3">${row.avg_ad_spend?.toFixed(2) || '0.00'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(!torts || torts.length === 0) && (
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

function Cell(props: any) {
  return <path {...props} />;
}
