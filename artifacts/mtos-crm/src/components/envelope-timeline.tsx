import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Clock, Eye, FileSignature, Send, XCircle, AlertTriangle, Inbox, RefreshCw, Mail } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface EnvelopeEvent { type: string; at: string }
interface Envelope {
  id: number;
  template_id: number | null;
  provider: string;
  external_envelope_id: string | null;
  signer_name: string | null;
  signer_email: string | null;
  status: string;
  status_detail: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  events: EnvelopeEvent[];
  last_error: string | null;
  created_at: string;
}
interface FaxRow {
  id: number;
  source_file: string;
  vault_path: string;
  status: string;
  raw_text: string | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}
interface EmailRow {
  id: number;
  to_email: string;
  to_name: string | null;
  subject: string | null;
  provider: string | null;
  status: string;
  error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  failed_at: string | null;
  created_at: string;
}

const EMAIL_STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ComponentType<{ className?: string }> }> = {
  queued:     { label: "Queued",      variant: "secondary",   icon: Clock },
  sent:       { label: "Sent",        variant: "default",     icon: Send },
  delivered:  { label: "Delivered",   variant: "default",     icon: Inbox },
  deferred:   { label: "Deferred",    variant: "secondary",   icon: Clock },
  bounced:    { label: "Bounced",     variant: "destructive", icon: XCircle },
  dropped:    { label: "Dropped",     variant: "destructive", icon: XCircle },
  spamreport: { label: "Spam Report", variant: "destructive", icon: AlertTriangle },
  failed:     { label: "Failed",      variant: "destructive", icon: AlertTriangle },
};

function emailStatusBadge(s: string) {
  const meta = EMAIL_STATUS_META[s] || { label: s, variant: "outline" as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ComponentType<{ className?: string }> }> = {
  created:   { label: "Created",    variant: "secondary",   icon: Clock },
  sent:      { label: "Sent",       variant: "default",     icon: Send },
  delivered: { label: "Delivered",  variant: "default",     icon: Inbox },
  viewed:    { label: "Viewed",     variant: "default",     icon: Eye },
  signed:    { label: "Signed",     variant: "default",     icon: CheckCircle2 },
  declined:  { label: "Declined",   variant: "destructive", icon: XCircle },
  voided:    { label: "Voided",     variant: "destructive", icon: XCircle },
  expired:   { label: "Expired",    variant: "destructive", icon: XCircle },
  error:     { label: "Error",      variant: "destructive", icon: AlertTriangle },
};

function statusBadge(s: string) {
  const meta = STATUS_META[s] || { label: s, variant: "outline" as const, icon: Clock };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

function fmt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

export function EnvelopeTimeline({ leadId }: { leadId: number }) {
  const { toast } = useToast();
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [faxes, setFaxes] = useState<FaxRow[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [templates, setTemplates] = useState<Record<number, string>>({});

  const load = async () => {
    setRefreshing(true);
    try {
      const [eRes, fRes, mRes, tRes] = await Promise.all([
        apiFetchRaw(`/api/leads/${leadId}/envelopes`),
        apiFetchRaw(`/api/leads/${leadId}/fax-results`),
        apiFetchRaw(`/api/leads/${leadId}/emails`),
        apiFetchRaw(`/api/document-templates`),
      ]);
      if (eRes.ok) setEnvelopes(await eRes.json());
      if (fRes.ok) setFaxes(await fRes.json());
      if (mRes.ok) setEmails(await mRes.json());
      if (tRes.ok) {
        const tpls = await tRes.json();
        const map: Record<number, string> = {};
        for (const t of tpls) map[t.id] = t.name;
        setTemplates(map);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); }, [leadId]);

  const simulate = async (externalId: string) => {
    const res = await apiFetchRaw("/api/webhooks/_test/envelope-signed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ external_envelope_id: externalId }),
    });
    if (!res.ok) {
      toast({ title: "Simulate failed", variant: "destructive" });
      return;
    }
    toast({ title: "Marked as signed (test)", description: "Refreshing in a moment…" });
    setTimeout(load, 800);
  };

  if (loading) return <p className="text-muted-foreground">Loading automation activity…</p>;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileSignature className="h-5 w-5" /> Document Envelopes</CardTitle>
          <CardDescription>E-signature packets sent to this claimant.</CardDescription>
        </CardHeader>
        <CardContent>
          {envelopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No envelopes sent yet. They auto-send when this lead is qualified.
            </p>
          ) : (
            <div className="space-y-4">
              {envelopes.map((env) => {
                const events = env.events || [];
                const milestones: Array<{ label: string; at: string | null }> = [
                  { label: "Created",   at: env.created_at },
                  { label: "Sent",      at: env.sent_at },
                  { label: "Delivered", at: env.delivered_at },
                  { label: "Viewed",    at: env.viewed_at },
                  { label: "Signed",    at: env.signed_at },
                ];
                if (env.declined_at) milestones.push({ label: "Declined", at: env.declined_at });
                return (
                  <div key={env.id} className="rounded-md border p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">
                          {env.template_id ? templates[env.template_id] || `Template #${env.template_id}` : "Ad-hoc envelope"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {env.provider} · {env.external_envelope_id || "no external id"}
                        </div>
                        {env.signer_email && (
                          <div className="text-xs text-muted-foreground">
                            To: {env.signer_name ? `${env.signer_name} <${env.signer_email}>` : env.signer_email}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {statusBadge(env.status)}
                        {env.status !== "signed" && env.external_envelope_id && (
                          <Button size="sm" variant="outline" onClick={() => simulate(env.external_envelope_id!)}>
                            Simulate signed
                          </Button>
                        )}
                      </div>
                    </div>

                    {env.last_error && (
                      <div className="rounded-md bg-destructive/10 border border-destructive/30 p-2 text-xs text-destructive">
                        <span className="font-medium">Error:</span> {env.last_error}
                      </div>
                    )}

                    <div className="grid grid-cols-5 gap-2 text-xs">
                      {milestones.map((m) => (
                        <div key={m.label} className={`rounded border p-2 ${m.at ? "bg-muted/40" : "opacity-50"}`}>
                          <div className="font-medium">{m.label}</div>
                          <div className="text-muted-foreground">{fmt(m.at) || "—"}</div>
                        </div>
                      ))}
                    </div>

                    {events.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          {events.length} event{events.length === 1 ? "" : "s"} from provider
                        </summary>
                        <div className="mt-2 space-y-1 pl-2 border-l">
                          {events.map((ev, i) => (
                            <div key={i}>
                              <span className="text-muted-foreground">{fmt(ev.at)}</span> · {ev.type}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5" /> Doctor Faxes</CardTitle>
          <CardDescription>Medical-records requests faxed automatically once HIPAA returns signed.</CardDescription>
        </CardHeader>
        <CardContent>
          {faxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No faxes yet. One will be sent automatically once a HIPAA template is signed.
            </p>
          ) : (
            <div className="space-y-3">
              {faxes.map((f) => (
                <div key={f.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-medium">{f.source_file}</div>
                      <div className="text-xs text-muted-foreground">
                        Created {fmt(f.created_at)}
                        {f.processed_at && ` · Processed ${fmt(f.processed_at)}`}
                      </div>
                    </div>
                    <Badge variant={f.status === "done" ? "default" : f.status === "error" ? "destructive" : "secondary"}>
                      {f.status}
                    </Badge>
                  </div>
                  {f.raw_text && (
                    <div className="mt-2 text-xs text-muted-foreground line-clamp-2">{f.raw_text}</div>
                  )}
                  {f.error && (
                    <div className="mt-2 text-xs text-destructive">{f.error}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" /> Emails</CardTitle>
          <CardDescription>Outbound emails sent to this claimant, with delivery status from the provider.</CardDescription>
        </CardHeader>
        <CardContent>
          {emails.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No emails sent yet. They are logged here automatically when a workflow or intake emails this lead.
            </p>
          ) : (
            <div className="space-y-3">
              {emails.map((m) => {
                const milestones: Array<{ label: string; at: string | null }> = [
                  { label: "Sent",      at: m.sent_at },
                  { label: "Delivered", at: m.delivered_at },
                ];
                if (m.bounced_at) milestones.push({ label: "Bounced", at: m.bounced_at });
                else if (m.failed_at) milestones.push({ label: "Failed", at: m.failed_at });
                return (
                  <div key={m.id} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{m.subject || "(no subject)"}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          To: {m.to_name ? `${m.to_name} <${m.to_email}>` : m.to_email}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.provider || "email"} · {fmt(m.created_at)}
                        </div>
                      </div>
                      {emailStatusBadge(m.status)}
                    </div>
                    {m.error && (
                      <div className="rounded-md bg-destructive/10 border border-destructive/30 p-2 text-xs text-destructive">
                        <span className="font-medium">Error:</span> {m.error}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {milestones.map((ms) => (
                        <div key={ms.label} className={`rounded border p-2 ${ms.at ? "bg-muted/40" : "opacity-50"}`}>
                          <div className="font-medium">{ms.label}</div>
                          <div className="text-muted-foreground">{fmt(ms.at) || "—"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
