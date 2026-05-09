/**
 * Backwards-compatible shim.
 *
 * As of Task #52 the outbound webhook dispatcher is generic and lives in
 * `event-dispatcher.ts`. This module preserves the original
 * `dispatchLeadCreated` / `pingLeadWebhook` surface so existing callsites
 * (routes/leads.ts, routes/web-forms.ts, routes/integrations.ts) keep
 * working unchanged. New events should call `dispatchEvent` directly.
 */
import { dispatchEvent, pingIntegration } from "./event-dispatcher";

export interface LeadWebhookLeadRef {
  id: number;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  state: string | null;
  tort_type: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
}

export interface DispatchInput {
  source: string;
  lead: LeadWebhookLeadRef;
}

export interface PingResult {
  attempted: boolean;
  reason?: "no_webhook_url" | "not_active" | "not_found" | "wrong_type";
  response_status?: number;
  latency_ms?: number;
  signed?: boolean;
  delivery_id?: string;
  error?: string;
}

export function dispatchLeadCreated(input: DispatchInput): void {
  dispatchEvent(
    { event: "lead.created", payload: { lead: input.lead } },
    { source: input.source },
  );
}

export async function pingLeadWebhook(integrationId: number): Promise<PingResult> {
  return pingIntegration(integrationId, {
    event: "lead.created",
    payload: {
      lead: {
        id: 0,
        name: "Sample Test Lead",
        first_name: "Sample",
        last_name: "Lead",
        email: "sample-lead@example.com",
        state: "CA",
        tort_type: "AFFF / PFAS",
        status: "web_form_intake",
        source: "test_ping",
        created_at: new Date().toISOString(),
      },
    },
  });
}
