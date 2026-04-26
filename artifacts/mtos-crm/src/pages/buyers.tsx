import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Plus, Pencil, Trash2 } from "lucide-react";

interface Buyer {
  id: number;
  name: string;
  legal_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  esign_provider_integration_id: number | null;
  fax_provider_integration_id: number | null;
  email_provider_integration_id: number | null;
  default_email_from_name: string | null;
  default_email_from_address: string | null;
  default_fax_from_number: string | null;
  active: boolean;
}

interface ProviderOption { id: number; name: string; provider: string; adapter_implemented: boolean }
interface ProviderOptions { esign: ProviderOption[]; fax: ProviderOption[]; email: ProviderOption[] }

const EMPTY: Partial<Buyer> = { name: "", active: true };

export default function BuyersPage() {
  const { toast } = useToast();
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [options, setOptions] = useState<ProviderOptions>({ esign: [], fax: [], email: [] });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Buyer>>(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const [bRes, oRes] = await Promise.all([
        fetch("/api/buyers"),
        fetch("/api/workflow-settings/_options/providers"),
      ]);
      setBuyers(await bRes.json());
      if (oRes.ok) setOptions(await oRes.json());
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing.name?.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const isEdit = typeof editing.id === "number";
    const url = isEdit ? `/api/buyers/${editing.id}` : "/api/buyers";
    const method = isEdit ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast({ title: "Save failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
      return;
    }
    toast({ title: isEdit ? "Buyer updated" : "Buyer created" });
    setOpen(false);
    setEditing(EMPTY);
    load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this buyer? Leads with this buyer will not be deleted.")) return;
    const res = await fetch(`/api/buyers/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Delete failed", variant: "destructive" });
      return;
    }
    toast({ title: "Buyer deleted" });
    load();
  };

  const providerName = (id: number | null, list: ProviderOption[]) => {
    if (!id) return <span className="text-muted-foreground">— inherits global —</span>;
    const p = list.find((x) => x.id === id);
    return p ? p.name : <span className="text-destructive">deleted ({id})</span>;
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6" /> Buyers
          </h1>
          <p className="text-sm text-muted-foreground">Configure case buyers and per-buyer provider overrides.</p>
        </div>
        <Button onClick={() => { setEditing(EMPTY); setOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" /> New Buyer
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>All Buyers ({buyers.length})</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : buyers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No buyers yet. Add one to enable per-buyer provider routing.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>E-Sign</TableHead>
                  <TableHead>Fax</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buyers.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="font-medium">{b.name}</div>
                      {b.legal_name && <div className="text-xs text-muted-foreground">{b.legal_name}</div>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {b.contact_name || "—"}
                      {b.contact_email && <div className="text-xs text-muted-foreground">{b.contact_email}</div>}
                    </TableCell>
                    <TableCell className="text-sm">{providerName(b.esign_provider_integration_id, options.esign)}</TableCell>
                    <TableCell className="text-sm">{providerName(b.fax_provider_integration_id, options.fax)}</TableCell>
                    <TableCell className="text-sm">{providerName(b.email_provider_integration_id, options.email)}</TableCell>
                    <TableCell>
                      <Badge variant={b.active ? "default" : "secondary"}>{b.active ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => { setEditing(b); setOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(b.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{typeof editing.id === "number" ? "Edit Buyer" : "New Buyer"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name *</Label>
                <Input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div>
                <Label>Legal Name</Label>
                <Input value={editing.legal_name || ""} onChange={(e) => setEditing({ ...editing, legal_name: e.target.value })} />
              </div>
              <div>
                <Label>Contact Name</Label>
                <Input value={editing.contact_name || ""} onChange={(e) => setEditing({ ...editing, contact_name: e.target.value })} />
              </div>
              <div>
                <Label>Contact Email</Label>
                <Input value={editing.contact_email || ""} onChange={(e) => setEditing({ ...editing, contact_email: e.target.value })} />
              </div>
              <div>
                <Label>Contact Phone</Label>
                <Input value={editing.contact_phone || ""} onChange={(e) => setEditing({ ...editing, contact_phone: e.target.value })} />
              </div>
              <div className="flex items-end gap-2">
                <Switch checked={!!editing.active} onCheckedChange={(v) => setEditing({ ...editing, active: v })} />
                <Label>Active</Label>
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <div className="text-sm font-medium">Provider Overrides (optional — leave blank to inherit global)</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">E-Sign</Label>
                  <ProviderSelect value={editing.esign_provider_integration_id ?? null} options={options.esign} onChange={(v) => setEditing({ ...editing, esign_provider_integration_id: v })} />
                </div>
                <div>
                  <Label className="text-xs">Fax</Label>
                  <ProviderSelect value={editing.fax_provider_integration_id ?? null} options={options.fax} onChange={(v) => setEditing({ ...editing, fax_provider_integration_id: v })} />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <ProviderSelect value={editing.email_provider_integration_id ?? null} options={options.email} onChange={(v) => setEditing({ ...editing, email_provider_integration_id: v })} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Default Email From Name</Label>
                  <Input value={editing.default_email_from_name || ""} onChange={(e) => setEditing({ ...editing, default_email_from_name: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Default Email From Address</Label>
                  <Input value={editing.default_email_from_address || ""} onChange={(e) => setEditing({ ...editing, default_email_from_address: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Default Fax From Number</Label>
                  <Input value={editing.default_fax_from_number || ""} onChange={(e) => setEditing({ ...editing, default_fax_from_number: e.target.value })} />
                </div>
              </div>
            </div>

            <div>
              <Label>Notes</Label>
              <Textarea rows={3} value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderSelect({ value, options, onChange }: { value: number | null; options: ProviderOption[]; onChange: (v: number | null) => void }) {
  return (
    <select
      className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">— inherit global —</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}{!o.adapter_implemented ? " (no adapter)" : ""}
        </option>
      ))}
    </select>
  );
}
