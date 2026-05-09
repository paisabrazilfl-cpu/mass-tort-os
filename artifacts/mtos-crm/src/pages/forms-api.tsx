/**
 * Form API Directory
 *
 * One screen that answers "what's the URL and JSON shape for posting a
 * lead into form X?" for every form configured in this firm. Backed by
 * GET /api/admin/forms-api-directory which derives the URL + field
 * schema + sample payload from form_configurations + web_form_config.
 *
 * The public submit endpoint (POST /api/forms-public/submit/:formId)
 * has been live for a long time but had no operator-discoverable index;
 * this page is that index. n8n, Zapier, Make.com, and vendor backends
 * can all use these URLs directly with no API key (they're public,
 * per-IP rate-limited).
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp, Copy, FileCode2, Search, Globe } from "lucide-react";
import { Link } from "wouter";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface FieldDescriptor {
  key: string;
  label: string;
  type: string;
  required: boolean;
  section?: string;
  helper_text?: string;
  options?: string[];
  source: "web_form" | "custom" | "legacy_extra" | "legacy_exposure";
}

interface FormDirectoryEntry {
  id: string;
  label: string;
  category: string;
  active: boolean;
  web_form_enabled: boolean;
  intro_text: string | null;
  submit_path: string;
  method: "POST";
  content_type: string;
  auth: "anonymous_rate_limited";
  fields: FieldDescriptor[];
  sample_payload: Record<string, unknown>;
  curl_example: string;
}

interface DirectoryResponse {
  base_path: string;
  total: number;
  active: number;
  forms: FormDirectoryEntry[];
}

export default function FormsApiPage() {
  const { toast } = useToast();
  const [data, setData] = useState<DirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const origin = useMemo(() => (typeof window === "undefined" ? "" : window.location.origin), []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await apiFetchRaw("/api/admin/forms-api-directory");
        if (!res.ok) throw new Error(`Failed to load directory (${res.status})`);
        setData(await res.json());
      } catch (err: any) {
        setError(err?.message ?? "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function copy(text: string, what = "Copied") {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: what, description: "Copied to clipboard." }),
      () => toast({ title: "Copy failed", description: "Select and copy manually.", variant: "destructive" }),
    );
  }

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.forms;
    return data.forms.filter((f) =>
      f.id.toLowerCase().includes(q) ||
      f.label.toLowerCase().includes(q) ||
      f.category.toLowerCase().includes(q),
    );
  }, [data, filter]);

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <FileCode2 className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">Form API Directory</h1>
            <p className="text-muted-foreground">
              Every published intake form has a public POST URL. Use these to drop leads in from n8n, Zapier,
              vendor sites, or any HTTP client.
            </p>
          </div>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5" /> How public submission works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            <code className="px-1.5 py-0.5 bg-muted rounded text-xs">POST {data?.base_path ?? "/api/forms-public/submit"}/&lt;form_id&gt;</code>
            {" "}with a JSON body. <strong>No API key required</strong> — the endpoint is anonymous and per-IP
            rate-limited. The full intake pipeline (validation, dedup, scoring, auto-documents, conflict checks)
            runs server-side just like a browser submission.
          </p>
          <p className="text-muted-foreground">
            For authenticated CRM access (read leads, manage cases, trigger automations) use{" "}
            <Link href="/n8n-setup" className="underline">n8n / API Setup</Link> instead.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search forms by id, label, or category…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.active}/{data.total} active
            {filter && ` · ${filtered.length} matching`}
          </p>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading directory…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && !error && filtered.length === 0 && (
        <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">
          {filter ? "No forms match your search." : "No forms configured yet."}
        </CardContent></Card>
      )}

      <div className="space-y-3">
        {filtered.map((form) => {
          const isOpen = expanded.has(form.id);
          const fullUrl = `${origin}${form.submit_path}`;
          const curl = form.curl_example.replace("{ORIGIN}", origin);
          return (
            <Card key={form.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-base">{form.label}</CardTitle>
                      <Badge variant="outline" className="text-xs">{form.category}</Badge>
                      {form.active ? (
                        <Badge variant="secondary" className="text-xs">active</Badge>
                      ) : (
                        <Badge variant="destructive" className="text-xs">inactive</Badge>
                      )}
                      {form.web_form_enabled && (
                        <Badge className="text-xs bg-green-600">web form on</Badge>
                      )}
                    </div>
                    <code className="text-xs text-muted-foreground">{form.id}</code>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => toggle(form.id)}>
                    {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-xs uppercase text-muted-foreground mb-1">Submit URL</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-muted rounded font-mono text-xs break-all">
                      <span className="text-muted-foreground">POST</span> {fullUrl}
                    </code>
                    <Button size="sm" variant="outline" onClick={() => copy(fullUrl, "URL copied")}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs uppercase text-muted-foreground">Curl example</div>
                        <Button size="sm" variant="ghost" onClick={() => copy(curl, "Curl copied")}>
                          <Copy className="h-3 w-3 mr-1" /> Copy
                        </Button>
                      </div>
                      <pre className="px-3 py-2 bg-muted rounded font-mono text-xs overflow-x-auto whitespace-pre">{curl}</pre>
                    </div>

                    <div>
                      <div className="text-xs uppercase text-muted-foreground mb-1">Sample payload</div>
                      <pre className="px-3 py-2 bg-muted rounded font-mono text-xs overflow-x-auto">{JSON.stringify(form.sample_payload, null, 2)}</pre>
                    </div>

                    <div>
                      <div className="text-xs uppercase text-muted-foreground mb-1">
                        Fields ({form.fields.length})
                      </div>
                      {form.fields.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No fields configured. Standard contact fields (first_name, last_name, email, phone, state, consent_tcpa) still apply.
                        </p>
                      ) : (
                        <div className="border rounded divide-y">
                          {form.fields.map((f) => (
                            <div key={f.key} className="px-3 py-2 flex items-start gap-3 text-sm">
                              <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">{f.key}</code>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span>{f.label}</span>
                                  <Badge variant="outline" className="text-xs">{f.type}</Badge>
                                  {f.required && <Badge variant="destructive" className="text-xs">required</Badge>}
                                  {f.section && <Badge variant="secondary" className="text-xs">{f.section}</Badge>}
                                  <Badge variant="outline" className="text-xs opacity-60">{f.source}</Badge>
                                </div>
                                {f.helper_text && <p className="text-xs text-muted-foreground mt-0.5">{f.helper_text}</p>}
                                {f.options && f.options.length > 0 && (
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    options: {f.options.slice(0, 8).join(", ")}{f.options.length > 8 ? "…" : ""}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
