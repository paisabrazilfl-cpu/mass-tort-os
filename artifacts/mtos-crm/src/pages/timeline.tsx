import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Clock, Search, Calendar, Stethoscope, Shield, FileText, AlertTriangle, User } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface LeadOption {
  id: number;
  first_name: string | null;
  last_name: string | null;
  tort_type: string | null;
  status: string | null;
}

interface TimelineEvent {
  date: string;
  event: string;
  category: string;
  source: string;
  details?: string;
}

interface TimelineData {
  lead_id: number;
  lead_name: string;
  tort_type: string;
  events: TimelineEvent[];
  summary: { total_events: number; categories: string[]; date_range: { start: string; end: string } | null };
}

const categoryConfig: Record<string, { icon: typeof Clock; color: string; bg: string }> = {
  personal: { icon: User, color: "text-blue-600", bg: "bg-blue-100 border-blue-300" },
  exposure: { icon: AlertTriangle, color: "text-red-600", bg: "bg-red-100 border-red-300" },
  diagnosis: { icon: Stethoscope, color: "text-purple-600", bg: "bg-purple-100 border-purple-300" },
  legal: { icon: Shield, color: "text-green-600", bg: "bg-green-100 border-green-300" },
  verification: { icon: Shield, color: "text-teal-600", bg: "bg-teal-100 border-teal-300" },
  compliance: { icon: Shield, color: "text-indigo-600", bg: "bg-indigo-100 border-indigo-300" },
  document: { icon: FileText, color: "text-orange-600", bg: "bg-orange-100 border-orange-300" },
};

function leadLabel(l: LeadOption): string {
  const name = [l.first_name, l.last_name].filter(Boolean).join(" ").trim() || "Unnamed lead";
  const tort = l.tort_type ? ` — ${l.tort_type}` : "";
  return `${name} (#${l.id})${tort}`;
}

export default function Timeline() {
  const { toast } = useToast();
  const [leadId, setLeadId] = useState("");
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetchRaw("/api/leads?limit=500");
        if (res.ok) {
          const items = await res.json();
          if (Array.isArray(items)) setLeads(items);
        }
      } finally {
        setLeadsLoading(false);
      }
    })();
  }, []);

  const loadTimeline = async (id?: string) => {
    const target = id ?? leadId;
    if (!target) return;
    setLoading(true);
    try {
      const res = await apiFetchRaw(`/api/timeline/lead/${target}`);
      if (!res.ok) throw new Error("Failed");
      setTimeline(await res.json());
    } catch {
      toast({ title: "Failed to load timeline", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Medical Timeline Builder</h1>
      <p className="text-muted-foreground">Generate exposure and medical timelines from lead data, OCR results, and NPI records.</p>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-2 max-w-2xl">
            <Select
              value={leadId}
              onValueChange={(v) => {
                setLeadId(v);
                void loadTimeline(v);
              }}
              disabled={leadsLoading || loading}
            >
              <SelectTrigger className="flex-1" data-testid="select-timeline-lead">
                <SelectValue placeholder={leadsLoading ? "Loading leads…" : leads.length === 0 ? "No leads available" : "Pick a lead"} />
              </SelectTrigger>
              <SelectContent>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {leadLabel(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => loadTimeline()} disabled={loading || !leadId}>
              <Search className="h-4 w-4 mr-2" />
              {loading ? "Loading..." : "Rebuild"}
            </Button>
          </div>
          {!leadsLoading && leads.length === 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              No leads in the system yet. Add one from the New Intake page first.
            </p>
          )}
        </CardContent>
      </Card>

      {timeline && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{timeline.lead_name}</CardTitle>
              <CardDescription>
                {timeline.tort_type} | {timeline.summary.total_events} events
                {timeline.summary.date_range && ` | ${timeline.summary.date_range.start} to ${timeline.summary.date_range.end}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 flex-wrap">
                {timeline.summary.categories.map((cat) => {
                  const cfg = categoryConfig[cat] || { color: "text-gray-600", bg: "bg-gray-100" };
                  return (
                    <Badge key={cat} variant="outline" className={cfg.bg}>
                      {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </Badge>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gray-200" />
                <div className="space-y-6">
                  {timeline.events.map((event, i) => {
                    const cfg = categoryConfig[event.category] || { icon: Clock, color: "text-gray-600", bg: "bg-gray-100 border-gray-300" };
                    const Icon = cfg.icon;
                    return (
                      <div key={i} className="relative flex items-start gap-4 pl-2">
                        <div className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-2 bg-white ${cfg.bg}`}>
                          <Icon className={`h-4 w-4 ${cfg.color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm text-muted-foreground">{event.date}</span>
                            <Badge variant="outline" className="text-xs">{event.category}</Badge>
                            <Badge variant="secondary" className="text-xs">{event.source}</Badge>
                          </div>
                          <div className="font-medium mt-1">{event.event}</div>
                          {event.details && <div className="text-sm text-muted-foreground mt-0.5">{event.details}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {timeline.events.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-12 w-12 mx-auto mb-3" />
                  <div>No timeline events found for this lead.</div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
