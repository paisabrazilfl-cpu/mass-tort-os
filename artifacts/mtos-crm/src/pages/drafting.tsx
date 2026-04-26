import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FileText, Download, Sparkles, Copy } from "lucide-react";
import { apiFetchRaw } from "@/lib/api-fetch";

interface Template {
  id: string;
  name: string;
  description: string;
}

interface DraftResult {
  title: string;
  content: string;
  template_type: string;
  generated_at: string;
  fields_used: string[];
}

export default function Drafting() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [leadId, setLeadId] = useState("");
  const [firmName, setFirmName] = useState("");
  const [attorneyName, setAttorneyName] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  useEffect(() => {
    apiFetchRaw("/api/drafting/templates").then(r => r.json()).then(setTemplates).catch(() => {});
  }, []);

  const generateDraft = async () => {
    if (!selectedTemplate) { toast({ title: "Select a template", variant: "destructive" }); return; }
    setGenerating(true);
    try {
      const res = await apiFetchRaw("/api/drafting/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_type: selectedTemplate,
          lead_id: leadId || undefined,
          firm_name: firmName || undefined,
          attorney_name: attorneyName || undefined,
          custom_instructions: customInstructions || undefined,
        }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const result = await res.json();
      setDraft(result);
      setPreviewOpen(true);
    } catch {
      toast({ title: "Draft generation failed", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const downloadPdf = async () => {
    if (!selectedTemplate) return;
    setDownloadingPdf(true);
    try {
      const res = await apiFetchRaw("/api/drafting/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_type: selectedTemplate,
          lead_id: leadId || undefined,
          firm_name: firmName || undefined,
          attorney_name: attorneyName || undefined,
          custom_instructions: customInstructions || undefined,
        }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedTemplate}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "PDF download failed", variant: "destructive" });
    } finally {
      setDownloadingPdf(false);
    }
  };

  const copyToClipboard = () => {
    if (draft) {
      navigator.clipboard.writeText(draft.content);
      toast({ title: "Copied to clipboard" });
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">AI Document Drafting</h1>
      <p className="text-muted-foreground">Generate HIPAA authorizations, retainer agreements, and legal documents from lead data using AI.</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Template Selection</CardTitle>
            <CardDescription>Choose a document template to generate</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`p-3 rounded-lg border-2 cursor-pointer transition-colors ${selectedTemplate === t.id ? "border-primary bg-primary/5" : "border-transparent hover:border-gray-200"}`}
                onClick={() => setSelectedTemplate(t.id)}
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  <span className="font-medium">{t.name}</span>
                </div>
                <div className="text-sm text-muted-foreground mt-1">{t.description}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Customize the generated document</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>Lead ID (optional - auto-fills client data)</Label>
              <Input placeholder="e.g. 42" value={leadId} onChange={(e) => setLeadId(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Firm Name</Label>
              <Input placeholder="Smith & Associates LLP" value={firmName} onChange={(e) => setFirmName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Attorney Name</Label>
              <Input placeholder="Jane Smith, Esq." value={attorneyName} onChange={(e) => setAttorneyName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Custom Instructions (optional)</Label>
              <Textarea placeholder="Any specific requirements..." value={customInstructions} onChange={(e) => setCustomInstructions(e.target.value)} rows={3} />
            </div>
            <div className="flex gap-2">
              <Button onClick={generateDraft} disabled={generating || !selectedTemplate} className="flex-1">
                <Sparkles className="h-4 w-4 mr-2" />
                {generating ? "Generating..." : "Generate Draft"}
              </Button>
              <Button variant="outline" onClick={downloadPdf} disabled={downloadingPdf || !selectedTemplate}>
                <Download className="h-4 w-4 mr-2" />
                {downloadingPdf ? "..." : "PDF"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.title}</DialogTitle>
            <DialogDescription>
              Generated {draft?.generated_at ? new Date(draft.generated_at).toLocaleString() : ""}
              {draft?.fields_used && ` | ${draft.fields_used.length} fields used`}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <pre className="whitespace-pre-wrap text-sm font-mono bg-gray-50 p-4 rounded-lg border max-h-[50vh] overflow-y-auto">
              {draft?.content}
            </pre>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={copyToClipboard}>
              <Copy className="h-4 w-4 mr-2" />
              Copy
            </Button>
            <Button onClick={() => setPreviewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
