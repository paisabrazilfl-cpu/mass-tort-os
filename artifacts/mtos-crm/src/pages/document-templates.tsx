import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { FileText, Plus, Pencil, Trash2, Upload, Eye } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";
import { Skeleton } from "@/components/ui/skeleton";

interface Template {
  id: number;
  name: string;
  template_type: string;
  description: string | null;
  source: "pdf" | "ai";
  storage_path: string | null;
  ai_prompt: string | null;
  requires_signature: boolean;
  signer_role: string;
  delivery_subject: string | null;
  delivery_message: string | null;
  triggers_med_records_request: boolean;
  active: boolean;
}

const EMPTY: Partial<Template> = {
  name: "",
  template_type: "hipaa",
  source: "pdf",
  requires_signature: true,
  signer_role: "lead",
  triggers_med_records_request: false,
  active: true,
};

export default function DocumentTemplatesPage() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Template>>(EMPTY);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetchRaw("/api/document-templates");
      setTemplates(await res.json());
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleUpload = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: "File too large", description: "Max 25MB", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const res = await apiFetchRaw("/api/document-templates/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, base64 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Upload failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      const stored = await res.json();
      setEditing((e) => ({ ...e, storage_path: stored.storagePath, source: "pdf" }));
      toast({ title: "PDF uploaded", description: `${(stored.sizeBytes / 1024).toFixed(1)} KB` });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!editing.name?.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (editing.source === "pdf" && !editing.storage_path) {
      toast({ title: "Upload a PDF first", variant: "destructive" });
      return;
    }
    if (editing.source === "ai" && !editing.ai_prompt?.trim()) {
      toast({ title: "AI prompt is required for AI-drafted templates", variant: "destructive" });
      return;
    }
    const isEdit = typeof editing.id === "number";
    const url = isEdit ? `/api/document-templates/${editing.id}` : "/api/document-templates";
    const res = await apiFetchRaw(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast({ title: "Save failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
      return;
    }
    toast({ title: isEdit ? "Template updated" : "Template created" });
    setOpen(false);
    setEditing(EMPTY);
    load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this template? Existing envelopes are not affected.")) return;
    const res = await apiFetchRaw(`/api/document-templates/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Delete failed", variant: "destructive" });
      return;
    }
    toast({ title: "Template deleted" });
    load();
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6" /> Document Templates
          </h1>
          <p className="text-sm text-muted-foreground">Reusable PDFs (or AI-drafted documents) sent to leads on approval.</p>
        </div>
        <Button onClick={() => { setEditing(EMPTY); setOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" /> New Template
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>All Templates ({templates.length})</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates yet. Add a HIPAA, Affidavit, and Retainer to get started.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Triggers Fax?</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-40 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      {t.description && <div className="text-xs text-muted-foreground line-clamp-1">{t.description}</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline">{t.template_type}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={t.source === "ai" ? "secondary" : "default"}>{t.source.toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>
                      {t.triggers_med_records_request ? <Badge>Yes</Badge> : <span className="text-muted-foreground text-sm">No</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.active ? "default" : "secondary"}>{t.active ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {t.storage_path && (
                        <Button variant="ghost" size="icon" asChild>
                          <a href={`/api/document-templates/${t.id}/preview`} target="_blank" rel="noreferrer">
                            <Eye className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => { setEditing(t); setOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
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
            <DialogTitle>{typeof editing.id === "number" ? "Edit Template" : "New Template"}</DialogTitle>
            <DialogDescription>
              {typeof editing.id === "number"
                ? "Update template name, type, body, and merge tags."
                : "Create a reusable document template with merge tags for HIPAA, retainer, or affidavit forms."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name *</Label>
                <Input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div>
                <Label>Type</Label>
                <select
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={editing.template_type || "hipaa"}
                  onChange={(e) => setEditing({ ...editing, template_type: e.target.value })}
                >
                  <option value="hipaa">HIPAA</option>
                  <option value="affidavit">Affidavit</option>
                  <option value="retainer">Retainer</option>
                  <option value="medical_records_request">Medical Records Request</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div>
              <Label>Description</Label>
              <Textarea rows={2} value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Source</Label>
                <select
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={editing.source || "pdf"}
                  onChange={(e) => setEditing({ ...editing, source: e.target.value as "pdf" | "ai" })}
                >
                  <option value="pdf">PDF (uploaded)</option>
                  <option value="ai">AI-drafted</option>
                </select>
              </div>
              <div>
                <Label>Signer Role</Label>
                <Input value={editing.signer_role || ""} onChange={(e) => setEditing({ ...editing, signer_role: e.target.value })} />
              </div>
            </div>

            {editing.source === "pdf" ? (
              <div className="rounded-md border p-3 bg-muted/30">
                <Label>PDF File</Label>
                <div className="flex items-center gap-2 mt-2">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
                  />
                  <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                    <Upload className="mr-2 h-4 w-4" />{uploading ? "Uploading…" : "Upload PDF"}
                  </Button>
                  {editing.storage_path && (
                    <span className="text-xs text-muted-foreground truncate">✓ {editing.storage_path.split("/").pop()}</span>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <Label>AI Prompt</Label>
                <Textarea
                  rows={4}
                  placeholder="e.g. Draft a HIPAA authorization for {{lead.name}} releasing records to {{firm.name}}…"
                  value={editing.ai_prompt || ""}
                  onChange={(e) => setEditing({ ...editing, ai_prompt: e.target.value })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Email Subject (sent to lead)</Label>
                <Input value={editing.delivery_subject || ""} onChange={(e) => setEditing({ ...editing, delivery_subject: e.target.value })} />
              </div>
              <div>
                <Label>Email Message</Label>
                <Input value={editing.delivery_message || ""} onChange={(e) => setEditing({ ...editing, delivery_message: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3 bg-muted/30">
              <div className="flex items-center gap-2">
                <Switch checked={!!editing.requires_signature} onCheckedChange={(v) => setEditing({ ...editing, requires_signature: v })} />
                <Label>Requires signature</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={!!editing.triggers_med_records_request} onCheckedChange={(v) => setEditing({ ...editing, triggers_med_records_request: v })} />
                <Label>When this is signed → auto-fax doctor for medical records</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={!!editing.active} onCheckedChange={(v) => setEditing({ ...editing, active: v })} />
                <Label>Active (sent by default — override per buyer/tort in Assignments)</Label>
              </div>
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
