/**
 * Automation Docs (Task #52)
 *
 * Operator-facing reference page for wiring n8n / Zapier / Make.com
 * against the CRM. Pulls everything from /api/admin/event-catalog so the
 * docs can never go stale relative to what the server actually emits.
 *
 * - Lists every event the CRM dispatches + its payload shape
 * - Lists every API surface a workflow can call back into + its scope
 * - Lists every available API-key scope
 * - Documents auth + HMAC signing headers
 *
 * Admin-only (the API endpoint is gated by `api_keys:manage`).
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Webhook, KeyRound, BookOpen, ExternalLink } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface Catalog {
  events: Array<{ event: string; description: string; payload_shape: Record<string, unknown> }>;
  api_surface: Array<{ method: string; path: string; scope: string; description: string }>;
  available_scopes: string[];
  auth: {
    header: string;
    token_types: Array<{ type: string; description: string }>;
    api_key_admin_url: string;
  };
  webhook_signing: {
    header: string;
    algorithm: string;
    secret_source: string;
    headers: string[];
  };
}

export default function AutomationDocsPage() {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetchRaw("/api/admin/event-catalog");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Catalog = await res.json();
        if (!cancelled) setCatalog(data);
      } catch (e) {
        if (!cancelled) {
          toast({
            title: "Failed to load event catalog",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!catalog) return <div className="p-6 text-destructive">Catalog unavailable.</div>;

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-7 w-7" /> Automation API & Events
          </h1>
          <p className="text-muted-foreground mt-1">
            Reference for wiring external automation tools (n8n, Zapier, Make) into the CRM.
          </p>
        </div>
        <Link href="/integrations">
          <Button variant="outline">
            <ExternalLink className="h-4 w-4 mr-2" /> Manage integrations
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>Every API call must include:</p>
          <pre className="bg-muted p-3 rounded text-sm font-mono">{catalog.auth.header}</pre>
          <ul className="space-y-2">
            {catalog.auth.token_types.map((t) => (
              <li key={t.type} className="flex gap-2 items-start">
                <Badge variant="secondary">{t.type}</Badge>
                <span className="text-sm">{t.description}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Mint long-lived service-account tokens at{" "}
            <code className="text-xs">{catalog.auth.api_key_admin_url}</code> (admin only).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="h-5 w-5" /> Outbound events
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            Configure the events your integration receives by editing
            <code className="mx-1 text-xs">config.userConfig.subscribed_events</code> on its row in
            the Integrations admin page (or via <code className="text-xs">PATCH /api/integrations/:id</code>).
            Default subscription is <code className="text-xs">["lead.created"]</code>.
          </p>
          {catalog.events.map((evt) => (
            <div key={evt.event} className="border rounded-md p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Badge>{evt.event}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{evt.description}</p>
              <details>
                <summary className="cursor-pointer text-sm font-medium">Payload shape</summary>
                <pre className="bg-muted p-2 rounded text-xs mt-2 overflow-x-auto">
                  {JSON.stringify(evt.payload_shape, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhook signing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <strong>Algorithm:</strong> <code>{catalog.webhook_signing.algorithm}</code>
          </p>
          <p>
            <strong>Header:</strong> <code>{catalog.webhook_signing.header}</code>
          </p>
          <p>
            <strong>Secret source:</strong> {catalog.webhook_signing.secret_source}
          </p>
          <p>
            <strong>Envelope headers:</strong>{" "}
            {catalog.webhook_signing.headers.map((h) => (
              <code key={h} className="mr-2 text-xs">{h}</code>
            ))}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API surface</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left">
              <tr className="border-b">
                <th className="py-2 pr-4">Method</th>
                <th className="py-2 pr-4">Path</th>
                <th className="py-2 pr-4">Scope</th>
                <th className="py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {catalog.api_surface.map((row) => (
                <tr key={`${row.method} ${row.path}`} className="border-b">
                  <td className="py-2 pr-4 font-mono text-xs">{row.method}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{row.path}</td>
                  <td className="py-2 pr-4"><code className="text-xs">{row.scope}</code></td>
                  <td className="py-2 text-muted-foreground">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Available scopes</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {catalog.available_scopes.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-xs">{s}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
