import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Settings, Save, AlertTriangle } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { Skeleton } from "@/components/ui/skeleton";

interface ProviderOption { id: number; name: string; provider: string; adapter_implemented: boolean }
interface ProviderOptions { esign: ProviderOption[]; fax: ProviderOption[]; email: ProviderOption[] }

interface Settings {
  scope: string;
  esign_provider_integration_id: number | null;
  fax_provider_integration_id: number | null;
  email_provider_integration_id: number | null;
  default_email_from_name: string | null;
  default_email_from_address: string | null;
  default_fax_from_number: string | null;
  auto_send_on_approval: boolean;
  auto_fax_doctor_on_signed_hipaa: boolean;
  esign_resend_after_days: number;
  esign_expire_after_days: number;
  max_send_retries: number;
  notify_on_failure_email: string | null;
  notes: string | null;
}

const DEFAULTS: Settings = {
  scope: "global",
  esign_provider_integration_id: null,
  fax_provider_integration_id: null,
  email_provider_integration_id: null,
  default_email_from_name: null,
  default_email_from_address: null,
  default_fax_from_number: null,
  auto_send_on_approval: true,
  auto_fax_doctor_on_signed_hipaa: true,
  esign_resend_after_days: 3,
  esign_expire_after_days: 30,
  max_send_retries: 3,
  notify_on_failure_email: null,
  notes: null,
};

export default function WorkflowSettingsPage() {
  const { toast } = useToast();
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [options, setOptions] = useState<ProviderOptions>({ esign: [], fax: [], email: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [sRes, oRes] = await Promise.all([
          apiFetchRaw("/api/workflow-settings/global"),
          apiFetchRaw("/api/workflow-settings/_options/providers"),
        ]);
        if (sRes.ok) {
          const row = await sRes.json();
          setS({ ...DEFAULTS, ...row });
        }
        if (oRes.ok) setOptions(await oRes.json());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetchRaw("/api/workflow-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Save failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      toast({ title: "Workflow settings saved" });
    } finally {
      setSaving(false);
    }
  };

  const ProviderPicker = ({
    label, value, options: opts, onChange, hint,
  }: { label: string; value: number | null; options: ProviderOption[]; onChange: (v: number | null) => void; hint?: string }) => (
    <div>
      <Label>{label}</Label>
      <select
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— none configured —</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.provider}){!o.adapter_implemented ? " — NO ADAPTER" : ""}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      {opts.length === 0 && (
        <div className="flex items-center gap-1 text-xs text-amber-600 mt-1">
          <AlertTriangle className="h-3 w-3" /> No active integrations of this type.{" "}
          <Link href="/integrations" className="underline hover:text-amber-700" data-testid="link-add-integration">
            Add one on the Integrations page →
          </Link>
        </div>
      )}
      {opts.length > 0 && value === null && (() => {
        const usable = opts.filter((o) => o.adapter_implemented).length;
        if (usable === 0) {
          return (
            <div className="flex items-center gap-1 text-xs text-amber-600 mt-1">
              <AlertTriangle className="h-3 w-3" />
              {`${opts.length} active integration${opts.length === 1 ? "" : "s"} of this type — but none has an adapter implemented yet, so jobs will still fail.`}
            </div>
          );
        }
        return (
          <div className="flex items-center gap-1 text-xs text-amber-600 mt-1">
            <AlertTriangle className="h-3 w-3" />
            {usable === 1
              ? `1 active integration available but none selected. Jobs that need this provider will fail until you pick one.`
              : `${usable} active integrations available but none selected. Jobs that need this provider will fail until you pick one.`}
          </div>
        );
      })()}
    </div>
  );

  if (loading) return (
    <div className="p-6 space-y-3">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="h-6 w-6" /> Workflow Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Global defaults for the document automation workflow. Per-buyer overrides live on the Buyers page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider Selection</CardTitle>
          <CardDescription>Pick which active integration to use for each step. These are pulled from your Integrations page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProviderPicker
            label="E-Signature Provider"
            value={s.esign_provider_integration_id}
            options={options.esign}
            onChange={(v) => setS({ ...s, esign_provider_integration_id: v })}
            hint="Used to send retainer / HIPAA / affidavit packets to leads on approval."
          />
          <ProviderPicker
            label="Fax Provider"
            value={s.fax_provider_integration_id}
            options={options.fax}
            onChange={(v) => setS({ ...s, fax_provider_integration_id: v })}
            hint="Used to send medical records requests to the lead's doctor after the HIPAA is signed."
          />
          <ProviderPicker
            label="Email Provider"
            value={s.email_provider_integration_id}
            options={options.email}
            onChange={(v) => setS({ ...s, email_provider_integration_id: v })}
            hint="Used for paralegal failure notifications and any non-e-signature email."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
          <CardDescription>Used when a buyer does not override.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label>Email From Name</Label>
            <Input value={s.default_email_from_name ?? ""} onChange={(e) => setS({ ...s, default_email_from_name: e.target.value || null })} />
          </div>
          <div>
            <Label>Email From Address</Label>
            <Input value={s.default_email_from_address ?? ""} onChange={(e) => setS({ ...s, default_email_from_address: e.target.value || null })} />
          </div>
          <div>
            <Label>Fax From Number</Label>
            <Input value={s.default_fax_from_number ?? ""} onChange={(e) => setS({ ...s, default_fax_from_number: e.target.value || null })} />
          </div>
          <div>
            <Label>Notify on Failure (email)</Label>
            <Input value={s.notify_on_failure_email ?? ""} onChange={(e) => setS({ ...s, notify_on_failure_email: e.target.value || null })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Auto-send packets on lead approval</Label>
              <p className="text-xs text-muted-foreground">When a lead is qualified, automatically send all active templates.</p>
            </div>
            <Switch checked={s.auto_send_on_approval} onCheckedChange={(v) => setS({ ...s, auto_send_on_approval: v })} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Auto-fax doctor when HIPAA is signed</Label>
              <p className="text-xs text-muted-foreground">Once a HIPAA template returns signed, fax the medical records request to the lead's doctor on file.</p>
            </div>
            <Switch checked={s.auto_fax_doctor_on_signed_hipaa} onCheckedChange={(v) => setS({ ...s, auto_fax_doctor_on_signed_hipaa: v })} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Resend after (days)</Label>
              <Input type="number" min={0} value={s.esign_resend_after_days} onChange={(e) => setS({ ...s, esign_resend_after_days: Number(e.target.value) })} />
            </div>
            <div>
              <Label>Expire after (days)</Label>
              <Input type="number" min={1} value={s.esign_expire_after_days} onChange={(e) => setS({ ...s, esign_expire_after_days: Number(e.target.value) })} />
            </div>
            <div>
              <Label>Max retries</Label>
              <Input type="number" min={0} max={10} value={s.max_send_retries} onChange={(e) => setS({ ...s, max_send_retries: Number(e.target.value) })} />
            </div>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={s.notes ?? ""} onChange={(e) => setS({ ...s, notes: e.target.value || null })} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <Badge variant="outline">Scope: global</Badge>
        <Button onClick={save} disabled={saving}>
          <Save className="mr-2 h-4 w-4" />{saving ? "Saving…" : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
