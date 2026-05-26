/**
 * n8n / External API Setup
 *
 * Operator-facing page for wiring n8n (or Zapier, Make.com, a vendor's
 * backend, etc.) at the whole CRM. Everything the page needs already
 * exists server-side:
 *   - GET    /api/admin/api-keys                — list this firm's keys
 *   - POST   /api/admin/api-keys                — mint a new key (returns
 *                                                 plaintext ONCE)
 *   - DELETE /api/admin/api-keys/:id            — revoke
 *   - GET    /api/admin/api-keys/_meta/scopes   — known scope catalog
 *
 * The page surfaces:
 *   - Base URL (read from window.location.origin so dev preview /
 *     .replit.app / custom domains all just work)
 *   - Header format ("Authorization: Bearer mtos_...")
 *   - Live key list with create + revoke
 *   - Plaintext token shown ONCE on creation, with copy-to-clipboard
 *     and an explicit "save now, you cannot see this again" warning
 *   - Worked curl examples for the three most common operations so an
 *     operator can verify the key works in 30 seconds
 *
 * RBAC: every endpoint hit here requires `api_keys:manage`. Operators
 * without that perm see a friendly empty state instead of a 403 wall.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { KeyRound, Copy, Trash2, AlertTriangle, Plus, Webhook, Code2, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { apiFetchRaw } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface MintResult {
  id: number;
  name: string;
  scopes: string[];
  prefix: string;
  plaintext: string;
}

export default function N8nSetupPage() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [knownScopes, setKnownScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<Set<string>>(new Set());
  const [newDescription, setNewDescription] = useState("");
  const [newExpiresIn, setNewExpiresIn] = useState<string>("never");
  const [creating, setCreating] = useState(false);
  const [justMinted, setJustMinted] = useState<MintResult | null>(null);

  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return "https://your-crm.example.com";
    return window.location.origin;
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, scopesRes] = await Promise.all([
        apiFetchRaw("/api/admin/api-keys"),
        apiFetchRaw("/api/admin/api-keys/_meta/scopes"),
      ]);
      if (!keysRes.ok) {
        // 403 means the operator doesn't have api_keys:manage; render
        // the same empty-state path with a friendlier message rather
        // than a destructive error toast.
        if (keysRes.status === 403) {
          setError("You need the api_keys:manage permission to view this page. Ask an admin.");
          setKeys([]);
          return;
        }
        throw new Error(`Failed to load keys (${keysRes.status})`);
      }
      const keysJson = await keysRes.json();
      setKeys(keysJson.keys ?? []);
      if (scopesRes.ok) {
        const scopesJson = await scopesRes.json();
        setKnownScopes(scopesJson.scopes ?? []);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleCreate() {
    if (!newName.trim()) {
      toast({ title: "Name required", description: "Give the key a memorable name (e.g. 'n8n production').", variant: "destructive" });
      return;
    }
    if (newScopes.size === 0) {
      toast({ title: "At least one scope required", description: "Pick what the key can do.", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: newName.trim(),
        scopes: Array.from(newScopes),
      };
      if (newDescription.trim()) body["description"] = newDescription.trim();
      if (newExpiresIn !== "never") body["expires_in_days"] = Number(newExpiresIn);
      const res = await apiFetchRaw("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const minted = (await res.json()) as MintResult;
      setJustMinted(minted);
      setCreateOpen(false);
      setNewName("");
      setNewScopes(new Set());
      setNewDescription("");
      setNewExpiresIn("never");
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't create key", description: err?.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: number, name: string) {
    if (!confirm(`Revoke "${name}"? Any integration using this key will stop working immediately.`)) return;
    try {
      const res = await apiFetchRaw(`/api/admin/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Key revoked", description: `"${name}" is no longer accepted.` });
      await refresh();
    } catch (err: any) {
      toast({ title: "Couldn't revoke key", description: err?.message, variant: "destructive" });
    }
  }

  function copy(text: string, what = "Copied") {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: what, description: "Copied to clipboard." }),
      () => toast({ title: "Copy failed", description: "Select and copy manually.", variant: "destructive" }),
    );
  }

  // Worked-example curl snippets — base URL is hot-swapped from the
  // current origin so they're always paste-ready.
  const examples = useMemo(() => ({
    listLeads: `curl "${baseUrl}/api/leads?limit=5" \\\n  -H "Authorization: Bearer mtos_REPLACE_ME"`,
    createLead: `curl -X POST "${baseUrl}/api/leads" \\\n  -H "Authorization: Bearer mtos_REPLACE_ME" \\\n  -H "Content-Type: application/json" \\\n  -d '{"first_name":"Jane","last_name":"Doe","email":"jane@example.com","phone":"+15555550100","tort":"camp-lejeune"}'`,
    triggerAutomation: `curl -X POST "${baseUrl}/api/automations/{workflow_id}/run" \\\n  -H "Authorization: Bearer mtos_REPLACE_ME" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input":{"lead_id":123}}'`,
  }), [baseUrl]);

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <Webhook className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">n8n / External API Setup</h1>
            <p className="text-muted-foreground">Give n8n, Zapier, Make.com, or any HTTP client full programmatic access to the CRM.</p>
          </div>
        </div>
      </header>

      {/* Base URL + header format — the two things every integration needs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> How to authenticate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs uppercase text-muted-foreground">Base URL</Label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-3 py-2 bg-muted rounded font-mono text-sm">{baseUrl}/api</code>
              <Button size="sm" variant="outline" onClick={() => copy(`${baseUrl}/api`, "Base URL copied")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase text-muted-foreground">Auth header (every request)</Label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-3 py-2 bg-muted rounded font-mono text-sm">Authorization: Bearer mtos_YOUR_KEY</code>
              <Button size="sm" variant="outline" onClick={() => copy("Authorization: Bearer mtos_YOUR_KEY", "Header copied")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Tokens are sha-hashed at rest; we cannot recover one once minted. Each request is scope-checked and
              audit-logged ({" "}
              <Link href="/automation-docs" className="underline">see what's logged</Link>
              ). Revoking a key takes effect immediately.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* API key management — list + create + revoke */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Your API keys</CardTitle>
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-4 w-4 mr-1" /> New key
          </Button>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && keys.length === 0 && (
            <p className="text-sm text-muted-foreground">No keys yet. Click "New key" to mint one for n8n.</p>
          )}
          {!loading && keys.length > 0 && (
            <div className="space-y-2">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between p-3 border rounded">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{k.name}</span>
                      {k.revoked_at ? (
                        <Badge variant="destructive">revoked</Badge>
                      ) : (
                        <Badge variant="secondary">active</Badge>
                      )}
                      <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="text-xs">{s}</Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last used: {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                      {" · "}
                      Created: {k.created_at ? new Date(k.created_at).toLocaleString() : "—"}
                    </p>
                  </div>
                  {!k.revoked_at && (
                    <Button size="sm" variant="ghost" onClick={() => handleRevoke(k.id, k.name)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Curl examples — paste-ready, base URL hot-swapped */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Code2 className="h-5 w-5" /> Try it: worked examples</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ExampleBlock title="List recent leads" code={examples.listLeads} onCopy={copy} />
          <ExampleBlock title="Create a lead" code={examples.createLead} onCopy={copy} />
          <ExampleBlock title="Trigger an automation workflow" code={examples.triggerAutomation} onCopy={copy} />
        </CardContent>
      </Card>

      {/* Pointers to the rest of the surface */}
      <Card>
        <CardHeader>
          <CardTitle>Where to go next</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <Link href="/automation-docs" className="underline inline-flex items-center gap-1">
              Automation Docs <ExternalLink className="h-3 w-3" />
            </Link>{" "}
            — every event the CRM emits, every endpoint your workflow can call, and the full automation node catalog.
          </p>
          <p>
            <Link href="/forms-api" className="underline inline-flex items-center gap-1">
              Form API Directory <ExternalLink className="h-3 w-3" />
            </Link>{" "}
            — public submit URLs for every published intake form. n8n / vendors can POST leads here without an API key.
          </p>
          <p>
            <Link href="/integrations" className="underline inline-flex items-center gap-1">
              Integrations <ExternalLink className="h-3 w-3" />
            </Link>{" "}
            — configure outbound webhook destinations + which events each one subscribes to.
          </p>
        </CardContent>
      </Card>

      {/* Create-key dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mint a new API key</DialogTitle>
            <DialogDescription>
              Pick the narrowest set of scopes that gets the job done. You can always mint another key later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" placeholder="e.g. n8n production" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="key-description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="key-description"
                placeholder="What is this key used for?"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
              />
            </div>
            <div>
              <Label htmlFor="key-expires">Expiration</Label>
              <select
                id="key-expires"
                value={newExpiresIn}
                onChange={(e) => setNewExpiresIn(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="never">Never expires</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days (recommended)</option>
                <option value="180">180 days</option>
                <option value="365">1 year</option>
                <option value="730">2 years</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Short-lived keys reduce blast radius if a token is leaked.
              </p>
            </div>
            <div>
              <Label>Scopes</Label>
              <div className="mt-2 max-h-64 overflow-y-auto border rounded p-3 space-y-2">
                {knownScopes.length === 0 && <p className="text-xs text-muted-foreground">Loading scope catalog…</p>}
                {knownScopes.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={newScopes.has(s)}
                      onCheckedChange={(checked) => {
                        const next = new Set(newScopes);
                        if (checked) next.add(s); else next.delete(s);
                        setNewScopes(next);
                      }}
                    />
                    <code className="text-xs">{s}</code>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating}>{creating ? "Minting…" : "Create key"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time plaintext display — opens automatically after mint */}
      <Dialog open={!!justMinted} onOpenChange={(o) => !o && setJustMinted(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-orange-500" /> Save this key now</DialogTitle>
            <DialogDescription>
              This is the only time you will see the full token. Copy it into n8n's HTTP credential or your .env file
              before closing this dialog. We store only a hash; we cannot show it to you again.
            </DialogDescription>
          </DialogHeader>
          {justMinted && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs uppercase text-muted-foreground">{justMinted.name}</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 px-3 py-2 bg-muted rounded font-mono text-xs break-all">{justMinted.plaintext}</code>
                  <Button size="sm" variant="outline" onClick={() => copy(justMinted.plaintext, "Token copied")}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {justMinted.scopes.map((s) => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setJustMinted(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExampleBlock({ title, code, onCopy }: { title: string; code: string; onCopy: (s: string, w?: string) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs uppercase text-muted-foreground">{title}</Label>
        <Button size="sm" variant="ghost" onClick={() => onCopy(code, "Example copied")}>
          <Copy className="h-3 w-3 mr-1" /> Copy
        </Button>
      </div>
      <pre className="px-3 py-2 bg-muted rounded font-mono text-xs overflow-x-auto whitespace-pre">{code}</pre>
    </div>
  );
}
