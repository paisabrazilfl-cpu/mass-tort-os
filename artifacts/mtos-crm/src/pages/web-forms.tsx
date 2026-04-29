import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  AppWindow,
  Copy,
  Plus,
  Save,
  Trash2,
  Code,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { Skeleton } from "@/components/ui/skeleton";

// ─────────────────────────────────────────────────────────────────────────
// Types — these are intentionally a structural mirror of `WebFormConfig`
// in lib/db/src/schema/form_configurations.ts. The PUT endpoint validates
// the payload against `webFormConfigSchema` server-side, so anything that
// drifts from this shape will fail at save time with a 400 + zod issues.
// ─────────────────────────────────────────────────────────────────────────

type WebFormFieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "select"
  | "radio"
  | "textarea"
  | "checkbox"
  | "state";

type WebFormSection = "eligibility" | "contact" | "story";

interface WebFormField {
  key: string;
  label: string;
  type: WebFormFieldType;
  section: WebFormSection;
  required: boolean;
  placeholder?: string;
  helper_text?: string;
  options?: string[];
  max_length?: number;
}

type EligibilityOp = "eq" | "ne" | "in" | "not_in" | "lt" | "gt";

interface EligibilityRule {
  id: string;
  field: string;
  op: EligibilityOp;
  value: string | number | string[];
  message: string;
}

interface WebFormConfig {
  enabled: boolean;
  intro_headline: string;
  intro_subhead: string;
  fields: WebFormField[];
  eligibility_rules: EligibilityRule[];
  send_confirmation_email: boolean;
  confirmation_subject: string;
  confirmation_body_html: string;
}

interface WebFormSummary {
  tort_id: string;
  tort_label: string;
  category: string;
  active: boolean;
  web_form_enabled: boolean;
  field_count: number;
  rule_count: number;
  send_confirmation_email: boolean;
  configured: boolean;
  updated_at: string;
}

interface FetchSummariesResp {
  web_forms: WebFormSummary[];
}

interface FetchOneResp {
  tort_id: string;
  tort_label: string;
  web_form_config: WebFormConfig;
  is_default: boolean;
  updated_at: string;
}

const FIELD_TYPE_OPTIONS: WebFormFieldType[] = [
  "text",
  "email",
  "tel",
  "date",
  "number",
  "select",
  "radio",
  "textarea",
  "checkbox",
  "state",
];

const OPERATOR_OPTIONS: EligibilityOp[] = [
  "eq",
  "ne",
  "in",
  "not_in",
  "lt",
  "gt",
];

const OPERATOR_LABEL: Record<EligibilityOp, string> = {
  eq: "equals",
  ne: "not equals",
  in: "in (comma-separated)",
  not_in: "not in (comma-separated)",
  lt: "less than",
  gt: "greater than",
};

const SECTIONS: WebFormSection[] = ["eligibility", "contact", "story"];

function buildEmbedSnippet(tortId: string, origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `<div id="mtos-web-form"></div>\n<script src="${base}/api/web-forms/${tortId}/embed.js" defer></script>`;
}

function buildPublicConfigUrl(tortId: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/web-forms/${tortId}`;
}

// =============================================================================
// LIST PAGE
// =============================================================================

export default function WebFormsPage() {
  const { toast } = useToast();
  const [summaries, setSummaries] = useState<WebFormSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingTortId, setEditingTortId] = useState<string | null>(null);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  async function loadSummaries() {
    setLoadError(null);
    try {
      const res = await apiFetchRaw("/api/forms/web-config");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as FetchSummariesResp;
      const sorted = [...data.web_forms].sort((a, b) => {
        if (a.web_form_enabled !== b.web_form_enabled) {
          return a.web_form_enabled ? -1 : 1;
        }
        return a.tort_label.localeCompare(b.tort_label);
      });
      setSummaries(sorted);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load web forms",
      );
    }
  }

  useEffect(() => {
    void loadSummaries();
  }, []);

  async function handleToggle(tortId: string, next: boolean) {
    const prev = summaries;
    if (summaries) {
      setSummaries(
        summaries.map((s) =>
          s.tort_id === tortId ? { ...s, web_form_enabled: next } : s,
        ),
      );
    }
    try {
      const res = await apiFetchRaw(
        `/api/forms/web-config/${encodeURIComponent(tortId)}/toggle`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      toast({
        title: next ? "Web form enabled" : "Web form disabled",
        description: `${tortId} is now ${next ? "accepting" : "rejecting"} public submissions.`,
      });
    } catch (err) {
      setSummaries(prev);
      toast({
        title: "Toggle failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${label} copied to clipboard.` });
    } catch {
      toast({
        title: "Copy failed",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <AppWindow className="h-6 w-6" /> Web Forms
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Public, embeddable lead-capture forms — one per tort. Submissions
            run through the same validation pipeline as the operator intake
            (email + address validation, eligibility rules, audit log) and
            land as leads with status{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              web_form_intake
            </code>
            . If a tort's form is disabled below, the public submit endpoint
            returns 403 and no lead is created.
          </p>
        </div>
      </div>

      {loadError ? (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertTriangle className="text-destructive h-5 w-5" />
            <div>
              <div className="font-medium">Failed to load web forms</div>
              <div className="text-muted-foreground text-sm">{loadError}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void loadSummaries()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All torts</CardTitle>
          <CardDescription>
            {summaries
              ? `${summaries.filter((s) => s.web_form_enabled).length} of ${summaries.length} enabled`
              : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {summaries === null ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              {/* Mobile: card list */}
              <div className="divide-y md:hidden">
                {summaries.map((s) => (
                  <div key={s.tort_id} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {s.tort_label}
                        </div>
                        <div className="text-muted-foreground truncate text-xs">
                          {s.tort_id}
                        </div>
                        <div className="mt-1.5">
                          <Badge variant="outline" className="text-xs">
                            {s.category}
                          </Badge>
                        </div>
                      </div>
                      <Switch
                        checked={s.web_form_enabled}
                        onCheckedChange={(v) => void handleToggle(s.tort_id, v)}
                        aria-label={`Toggle ${s.tort_label}`}
                      />
                    </div>
                    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span>
                        <span className="text-foreground font-medium">
                          {s.field_count}
                        </span>{" "}
                        fields
                      </span>
                      <span>
                        <span className="text-foreground font-medium">
                          {s.rule_count}
                        </span>{" "}
                        rules
                      </span>
                      <span>
                        Email:{" "}
                        <span className="text-foreground font-medium">
                          {s.send_confirmation_email ? "on" : "off"}
                        </span>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setEditingTortId(s.tort_id)}
                      >
                        Configure
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Copy embed snippet"
                        onClick={() =>
                          void copyToClipboard(
                            buildEmbedSnippet(s.tort_id, origin),
                            "Embed snippet",
                          )
                        }
                      >
                        <Code className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Copy public config URL"
                        onClick={() =>
                          void copyToClipboard(
                            buildPublicConfigUrl(s.tort_id, origin),
                            "Config URL",
                          )
                        }
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Tablet/desktop: table (horizontal-scroll fallback for tablets) */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[220px]">Tort</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-center">Enabled</TableHead>
                      <TableHead className="text-center">Fields</TableHead>
                      <TableHead className="text-center">Rules</TableHead>
                      <TableHead className="text-center">Email</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summaries.map((s) => (
                      <TableRow key={s.tort_id}>
                        <TableCell>
                          <div className="font-medium">{s.tort_label}</div>
                          <div className="text-muted-foreground text-xs">
                            {s.tort_id}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {s.category}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            checked={s.web_form_enabled}
                            onCheckedChange={(v) =>
                              void handleToggle(s.tort_id, v)
                            }
                            aria-label={`Toggle ${s.tort_label}`}
                          />
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {s.field_count}
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {s.rule_count}
                        </TableCell>
                        <TableCell className="text-center">
                          {s.send_confirmation_email ? (
                            <Badge variant="secondary" className="text-xs">
                              on
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              off
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Copy embed snippet"
                              onClick={() =>
                                void copyToClipboard(
                                  buildEmbedSnippet(s.tort_id, origin),
                                  "Embed snippet",
                                )
                              }
                            >
                              <Code className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Copy public config URL"
                              onClick={() =>
                                void copyToClipboard(
                                  buildPublicConfigUrl(s.tort_id, origin),
                                  "Config URL",
                                )
                              }
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingTortId(s.tort_id)}
                            >
                              Configure
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {editingTortId ? (
        <ConfigureDialog
          tortId={editingTortId}
          origin={origin}
          onClose={() => setEditingTortId(null)}
          onSaved={() => {
            setEditingTortId(null);
            void loadSummaries();
          }}
        />
      ) : null}
    </div>
  );
}

// =============================================================================
// CONFIGURE DIALOG
// =============================================================================

interface ConfigureDialogProps {
  tortId: string;
  origin: string;
  onClose: () => void;
  onSaved: () => void;
}

function ConfigureDialog({
  tortId,
  origin,
  onClose,
  onSaved,
}: ConfigureDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tortLabel, setTortLabel] = useState("");
  const [config, setConfig] = useState<WebFormConfig | null>(null);
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetchRaw(
          `/api/forms/web-config/${encodeURIComponent(tortId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FetchOneResp;
        if (cancelled) return;
        setConfig(data.web_form_config);
        setTortLabel(data.tort_label);
        setIsDefault(data.is_default);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tortId]);

  function update<K extends keyof WebFormConfig>(
    key: K,
    value: WebFormConfig[K],
  ) {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateField(idx: number, patch: Partial<WebFormField>) {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = [...prev.fields];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, fields: next };
    });
  }

  function removeField(idx: number) {
    setConfig((prev) => {
      if (!prev) return prev;
      const removedKey = prev.fields[idx].key;
      // Remove rules that reference the deleted field — leaving them would
      // make the PUT fail server-side, and silently dropping them is more
      // honest than letting the admin "save" a broken config.
      const rules = prev.eligibility_rules.filter(
        (r) => r.field !== removedKey,
      );
      const fields = prev.fields.filter((_, i) => i !== idx);
      return { ...prev, fields, eligibility_rules: rules };
    });
  }

  function addField() {
    setConfig((prev) => {
      if (!prev) return prev;
      let n = 1;
      let key = `custom_field_${n}`;
      const existing = new Set(prev.fields.map((f) => f.key));
      while (existing.has(key)) {
        n += 1;
        key = `custom_field_${n}`;
      }
      return {
        ...prev,
        fields: [
          ...prev.fields,
          {
            key,
            label: "New field",
            type: "text",
            required: false,
            section: "story",
          },
        ],
      };
    });
  }

  function updateRule(idx: number, patch: Partial<EligibilityRule>) {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = [...prev.eligibility_rules];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, eligibility_rules: next };
    });
  }

  function removeRule(idx: number) {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        eligibility_rules: prev.eligibility_rules.filter((_, i) => i !== idx),
      };
    });
  }

  function addRule() {
    setConfig((prev) => {
      if (!prev) return prev;
      const firstField = prev.fields[0]?.key ?? "";
      const id = `rule_${Date.now().toString(36)}`;
      return {
        ...prev,
        eligibility_rules: [
          ...prev.eligibility_rules,
          {
            id,
            field: firstField,
            op: "eq",
            value: "",
            message: "Sorry, you do not appear to qualify for this case.",
          },
        ],
      };
    });
  }

  async function handleSave() {
    if (!config) return;
    // Client-side dedupe + snake_case key sanity check — server enforces
    // both too, but this gives a faster error than the round-trip.
    const seen = new Set<string>();
    const snakeRe = /^[a-z][a-z0-9_]*$/;
    for (const f of config.fields) {
      if (!snakeRe.test(f.key)) {
        toast({
          title: "Invalid field key",
          description: `"${f.key}" must be snake_case (lowercase letters, digits, underscores; starts with a letter).`,
          variant: "destructive",
        });
        return;
      }
      if (seen.has(f.key)) {
        toast({
          title: "Duplicate field key",
          description: `Two fields use the key "${f.key}". Make field keys unique.`,
          variant: "destructive",
        });
        return;
      }
      seen.add(f.key);
    }
    setSaving(true);
    try {
      // Coerce rule.value to array shape for in/not_in operators.
      const cleaned: WebFormConfig = {
        ...config,
        eligibility_rules: config.eligibility_rules.map((r) => {
          if (
            (r.op === "in" || r.op === "not_in") &&
            typeof r.value === "string"
          ) {
            return {
              ...r,
              value: r.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            };
          }
          // Coerce numeric ops to numbers when the input parses cleanly.
          if (
            (r.op === "lt" || r.op === "gt") &&
            typeof r.value === "string" &&
            r.value.trim() !== "" &&
            !Number.isNaN(Number(r.value))
          ) {
            return { ...r, value: Number(r.value) };
          }
          return r;
        }),
      };
      const res = await apiFetchRaw(
        `/api/forms/web-config/${encodeURIComponent(tortId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cleaned),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      toast({
        title: "Web form saved",
        description: `${tortLabel} configuration updated.`,
      });
      onSaved();
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="flex h-[95vh] w-[95vw] max-w-5xl flex-col overflow-hidden p-0 sm:h-[92vh] sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Configure: {tortLabel}
            {isDefault ? (
              <Badge variant="outline" className="text-xs">
                using defaults (not yet saved)
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Edit fields, eligibility rules, and the confirmation email. Public
            URL: <code className="text-xs">{buildPublicConfigUrl(tortId, origin)}</code>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : error || !config ? (
          <div className="text-destructive p-4 text-sm">
            {error ?? "No config to display"}
          </div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto pr-2">
            {/* Top-level toggles */}
            <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex items-start gap-3 rounded-md border p-3">
                <Switch
                  checked={config.enabled}
                  onCheckedChange={(v) => update("enabled", v)}
                />
                <div>
                  <Label className="text-sm font-medium">
                    Form enabled (public submissions accepted)
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    When off, the public submit endpoint returns 403 and the
                    embed renders a "currently unavailable" message.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-md border p-3">
                <Switch
                  checked={config.send_confirmation_email}
                  onCheckedChange={(v) =>
                    update("send_confirmation_email", v)
                  }
                />
                <div>
                  <Label className="text-sm font-medium">
                    Send confirmation email on submit
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Uses the email provider chosen in Workflow Settings. Today
                    only SendGrid has a live send adapter shipped — if you pick
                    a vault-only provider (Mailgun, Postmark, SES, etc.) the
                    server audits "would_send_no_adapter" with the provider
                    name and never pretends it sent. Pick SendGrid to actually
                    deliver email.
                  </p>
                </div>
              </div>
            </section>

            {/* Copy editor */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Public copy</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <Label className="text-xs">Headline</Label>
                  <Input
                    value={config.intro_headline}
                    onChange={(e) => update("intro_headline", e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">Subhead</Label>
                  <Input
                    value={config.intro_subhead}
                    onChange={(e) => update("intro_subhead", e.target.value)}
                  />
                </div>
              </div>
            </section>

            <Separator />

            {/* Fields editor */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  Fields ({config.fields.length})
                </h3>
                <Button size="sm" variant="outline" onClick={addField}>
                  <Plus className="mr-1 h-4 w-4" /> Add field
                </Button>
              </div>
              <div className="space-y-2">
                {config.fields.map((f, idx) => (
                  <div
                    key={`${f.key}-${idx}`}
                    className="grid grid-cols-12 items-end gap-2 rounded-md border p-2"
                  >
                    <div className="col-span-2">
                      <Label className="text-[10px] uppercase">Key</Label>
                      <Input
                        value={f.key}
                        onChange={(e) =>
                          updateField(idx, { key: e.target.value })
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="col-span-3">
                      <Label className="text-[10px] uppercase">Label</Label>
                      <Input
                        value={f.label}
                        onChange={(e) =>
                          updateField(idx, { label: e.target.value })
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px] uppercase">Type</Label>
                      <Select
                        value={f.type}
                        onValueChange={(v) =>
                          updateField(idx, { type: v as WebFormFieldType })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIELD_TYPE_OPTIONS.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px] uppercase">Section</Label>
                      <Select
                        value={f.section}
                        onValueChange={(v) =>
                          updateField(idx, { section: v as WebFormSection })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SECTIONS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 flex items-center gap-2 pb-1">
                      <Switch
                        checked={f.required}
                        onCheckedChange={(v) =>
                          updateField(idx, { required: v })
                        }
                      />
                      <span className="text-xs">Required</span>
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeField(idx)}
                        title="Remove field"
                      >
                        <Trash2 className="text-destructive h-4 w-4" />
                      </Button>
                    </div>
                    {(f.type === "select" || f.type === "radio") ? (
                      <div className="col-span-12">
                        <Label className="text-[10px] uppercase">
                          Options (comma-separated)
                        </Label>
                        <Input
                          value={(f.options ?? []).join(", ")}
                          onChange={(e) =>
                            updateField(idx, {
                              options: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                    ) : null}
                    <div className="col-span-12">
                      <Label className="text-[10px] uppercase">
                        Helper text (optional)
                      </Label>
                      <Input
                        value={f.helper_text ?? ""}
                        onChange={(e) =>
                          updateField(idx, {
                            helper_text: e.target.value || undefined,
                          })
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <Separator />

            {/* Rules editor */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  If-then eligibility rules ({config.eligibility_rules.length}){" "}
                  <span className="text-muted-foreground text-xs font-normal">
                    — submissions failing any rule are blocked with the rule's
                    message. Rules run server-side; the embed only shows hints.
                  </span>
                </h3>
                <Button size="sm" variant="outline" onClick={addRule}>
                  <Plus className="mr-1 h-4 w-4" /> Add rule
                </Button>
              </div>
              <div className="space-y-2">
                {config.eligibility_rules.map((r, idx) => (
                  <div
                    key={r.id}
                    className="grid grid-cols-12 items-end gap-2 rounded-md border p-2"
                  >
                    <div className="col-span-3">
                      <Label className="text-[10px] uppercase">Field</Label>
                      <Select
                        value={r.field}
                        onValueChange={(v) => updateRule(idx, { field: v })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {config.fields.map((f) => (
                            <SelectItem key={f.key} value={f.key}>
                              {f.label} ({f.key})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px] uppercase">Operator</Label>
                      <Select
                        value={r.op}
                        onValueChange={(v) =>
                          updateRule(idx, { op: v as EligibilityOp })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPERATOR_OPTIONS.map((o) => (
                            <SelectItem key={o} value={o}>
                              {OPERATOR_LABEL[o]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Label className="text-[10px] uppercase">Value</Label>
                      <Input
                        value={
                          Array.isArray(r.value)
                            ? r.value.join(", ")
                            : String(r.value)
                        }
                        onChange={(e) =>
                          updateRule(idx, { value: e.target.value })
                        }
                        className="h-8 text-xs"
                        placeholder={
                          r.op === "in" || r.op === "not_in"
                            ? "comma,separated"
                            : ""
                        }
                      />
                    </div>
                    <div className="col-span-3">
                      <Label className="text-[10px] uppercase">
                        Reject message
                      </Label>
                      <Input
                        value={r.message}
                        onChange={(e) =>
                          updateRule(idx, { message: e.target.value })
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeRule(idx)}
                        title="Remove rule"
                      >
                        <Trash2 className="text-destructive h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                {config.eligibility_rules.length === 0 ? (
                  <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
                    No eligibility rules — every well-formed submission will
                    be accepted.
                  </div>
                ) : null}
              </div>
            </section>

            <Separator />

            {/* Confirmation email */}
            {config.send_confirmation_email ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Confirmation email</h3>
                <div>
                  <Label className="text-xs">Subject</Label>
                  <Input
                    value={config.confirmation_subject}
                    onChange={(e) =>
                      update("confirmation_subject", e.target.value)
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">
                    HTML body (placeholders: {"{first_name}"}, {"{tort_label}"})
                  </Label>
                  <Textarea
                    value={config.confirmation_body_html}
                    onChange={(e) =>
                      update("confirmation_body_html", e.target.value)
                    }
                    rows={8}
                    className="font-mono text-xs"
                  />
                </div>
              </section>
            ) : null}

            <Separator />

            {/* Embed snippet */}
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ExternalLink className="h-4 w-4" /> Embed on a landing page
              </h3>
              <pre className="rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
                {buildEmbedSnippet(tortId, origin)}
              </pre>
              <p className="text-muted-foreground text-xs">
                Drop this snippet into any HTML page. The script is dependency-
                free (no jQuery, no React) and renders the form into the{" "}
                <code>#mtos-web-form</code> div.
              </p>
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            <Save className="mr-1 h-4 w-4" />
            {saving ? "Saving..." : "Save configuration"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
