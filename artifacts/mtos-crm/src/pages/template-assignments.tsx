import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Grid3x3 } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { Skeleton } from "@/components/ui/skeleton";

interface Template { id: number; name: string; template_type: string; active: boolean }
interface Buyer { id: number; name: string }
interface Assignment {
  id: number;
  template_id: number;
  buyer_id: number | null;
  tort_type: string | null;
  enabled: boolean;
}
interface FormConfig { id: string; label: string; active: boolean }

export default function TemplateAssignmentsPage() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [torts, setTorts] = useState<FormConfig[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [selectedBuyer, setSelectedBuyer] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, bRes, aRes, fRes] = await Promise.all([
        apiFetchRaw("/api/document-templates"),
        apiFetchRaw("/api/buyers"),
        apiFetchRaw("/api/document-templates/assignments/all"),
        apiFetchRaw("/api/forms/config"),
      ]);
      setTemplates(await tRes.json());
      setBuyers(await bRes.json());
      setAssignments(await aRes.json());
      const formsBody = await fRes.json().catch(() => ({}));
      const list: FormConfig[] = Array.isArray(formsBody)
        ? formsBody
        : Array.isArray(formsBody?.tort_campaigns)
          ? formsBody.tort_campaigns
          : [];
      setTorts(list.filter((f) => f.active));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const lookup = useMemo(() => {
    const m = new Map<string, Assignment>();
    for (const a of assignments) {
      const k = `${a.template_id}|${a.buyer_id ?? "null"}|${a.tort_type ?? "null"}`;
      m.set(k, a);
    }
    return m;
  }, [assignments]);

  const resolved = (templateId: number, templateActive: boolean, tortId: string): boolean => {
    if (selectedBuyer) {
      const buyerKey = `${templateId}|${selectedBuyer}|${tortId}`;
      const buyerHit = lookup.get(buyerKey);
      if (buyerHit) return buyerHit.enabled;
    }
    const tortKey = `${templateId}|null|${tortId}`;
    const tortHit = lookup.get(tortKey);
    if (tortHit) return tortHit.enabled;
    return templateActive;
  };

  const toggle = async (templateId: number, tortId: string, current: boolean) => {
    const key = `${templateId}|${tortId}|${selectedBuyer ?? "global"}`;
    setSavingKey(key);
    try {
      const res = await apiFetchRaw("/api/document-templates/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: templateId,
          buyer_id: selectedBuyer,
          tort_type: tortId,
          enabled: !current,
          send_order: 0,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Save failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Grid3x3 className="h-6 w-6" /> Template Assignments
        </h1>
        <p className="text-sm text-muted-foreground">
          Toggle which templates are sent for each (buyer, tort) combination. Empty cell = uses template default.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setSelectedBuyer(null)}
              className={`px-3 py-1.5 rounded-md text-sm border ${selectedBuyer === null ? "bg-primary text-primary-foreground" : "bg-background"}`}
            >
              Global (all buyers)
            </button>
            {buyers.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBuyer(b.id)}
                className={`px-3 py-1.5 rounded-md text-sm border ${selectedBuyer === b.id ? "bg-primary text-primary-foreground" : "bg-background"}`}
              >
                {b.name}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {selectedBuyer
              ? "Buyer-specific overrides take precedence over global. Cells without a buyer override fall back to global."
              : "Global rules apply to all buyers unless that buyer overrides them."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{selectedBuyer ? `Matrix — ${buyers.find((b) => b.id === selectedBuyer)?.name}` : "Matrix — Global"}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : templates.length === 0 || torts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {templates.length === 0 ? "No templates configured. " : ""}
              {torts.length === 0 ? "No active torts in Form Engine. " : ""}
            </p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left p-2 font-medium border-b sticky left-0 bg-background">Template</th>
                  {torts.map((t) => (
                    <th key={t.id} className="p-2 font-medium border-b text-center min-w-[120px]">{t.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => (
                  <tr key={tpl.id} className="border-b">
                    <td className="p-2 sticky left-0 bg-background">
                      <div className="font-medium">{tpl.name}</div>
                      <div className="text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">{tpl.template_type}</Badge>
                      </div>
                    </td>
                    {torts.map((tort) => {
                      const enabled = resolved(tpl.id, tpl.active, tort.id);
                      const key = `${tpl.id}|${tort.id}|${selectedBuyer ?? "global"}`;
                      const cellKey = selectedBuyer
                        ? `${tpl.id}|${selectedBuyer}|${tort.id}`
                        : `${tpl.id}|null|${tort.id}`;
                      const hasOverride = lookup.has(cellKey);
                      return (
                        <td key={tort.id} className="p-2 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <Switch
                              checked={enabled}
                              disabled={savingKey === key}
                              onCheckedChange={() => toggle(tpl.id, tort.id, enabled)}
                            />
                            <span className="text-[10px] text-muted-foreground">
                              {hasOverride ? "explicit" : "inherited"}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
