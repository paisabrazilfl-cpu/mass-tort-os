import React, { useState, useRef } from "react";
import { useListFaxResults, getListFaxResultsQueryKey, useUploadFax, useGetOcrQueueStats } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Search, AlertCircle, CheckCircle, Clock, UploadCloud, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { apiFetchRaw } from "@/lib/api-fetch";

function getStatusBadge(status: string, isEmpty: boolean) {
  const s = status as string;
  if (s === "pending") return <Badge variant="secondary" className="bg-slate-500/10 text-slate-500 hover:bg-slate-500/20">Pending</Badge>;
  if (s === "processing") return <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"><Clock className="w-3 h-3 mr-1" />Processing</Badge>;
  if (s === "done") {
    if (isEmpty) return <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20"><AlertCircle className="w-3 h-3 mr-1" />Done (no data)</Badge>;
    return <Badge variant="secondary" className="bg-green-500/10 text-green-500 hover:bg-green-500/20"><CheckCircle className="w-3 h-3 mr-1" />Done</Badge>;
  }
  if (s === "error" || s === "failed") return <Badge variant="destructive" className="bg-red-500/10 text-red-500 hover:bg-red-500/20"><AlertCircle className="w-3 h-3 mr-1" />{s === "error" ? "Error" : "Failed"}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export default function OcrInbox() {
  const [searchTerm, setSearchTerm] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [reprocessing, setReprocessing] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");

  const { data: faxes = [], isLoading } = useListFaxResults({
    query: { refetchInterval: 8000 } as any,
  });
  const { data: queueStats } = useGetOcrQueueStats({
    query: { refetchInterval: 5000 } as any,
  });

  const uploadMutation = useUploadFax({
    mutation: {
      onSuccess: () => {
        toast({ title: "Fax uploaded successfully", description: "Processing has been queued." });
        queryClient.invalidateQueries({ queryKey: getListFaxResultsQueryKey() });
        setUploadOpen(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setFileName("");
      },
      onError: () => {
        toast({ title: "Failed to upload fax", variant: "destructive" });
      }
    }
  });

  const handleReprocess = async (id: number) => {
    setReprocessing(id);
    try {
      const res = await apiFetchRaw(`/api/ocr/results/${id}/reprocess`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Reprocess failed", description: body.error || `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      toast({ title: "Reprocessing queued", description: `Fax #${id} will be re-analyzed.` });
      queryClient.invalidateQueries({ queryKey: getListFaxResultsQueryKey() });
    } finally {
      setReprocessing(null);
    }
  };

  const filteredFaxes = faxes.filter(f =>
    f.id.toString().includes(searchTerm) ||
    (f.rx_number && f.rx_number.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (f.drug_name && f.drug_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (f.source_file && f.source_file.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      toast({ title: "Please select a file", variant: "destructive" });
      return;
    }

    const finalFileName = fileName.trim() || file.name;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64String = event.target?.result as string;
      uploadMutation.mutate({
        data: {
          file_name: finalFileName,
          image_base64: base64String,
          mime_type: file.type
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const toggleRow = (id: number) => {
    setExpandedRow(expandedRow === id ? null : id);
  };

  const isEmptyResult = (fax: typeof faxes[0]) =>
    !fax.raw_text && !fax.drug_name && !fax.rx_number && fax.confidence === 0;

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">OCR Inbox</h2>
          <p className="text-muted-foreground mt-1">Process and manage incoming faxes.</p>
        </div>
        <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
          <DialogTrigger asChild>
            <Button>
              <UploadCloud className="mr-2 h-4 w-4" />
              Upload Fax
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Fax for OCR Processing</DialogTitle>
              <DialogDescription>
                Upload a fax image or PDF to extract structured data and route results to the matching lead.
                Supported: PNG, JPEG, TIFF, PDF.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleUploadSubmit} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="file">Fax File</Label>
                <Input id="file" type="file" accept="image/*,application/pdf" ref={fileInputRef} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="filename">File Name Override (Optional)</Label>
                <Input
                  id="filename"
                  placeholder="E.g. patient-records.pdf"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={uploadMutation.isPending}>
                {uploadMutation.isPending ? "Uploading..." : "Submit for OCR"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {queueStats ? (
          ["pending", "processing", "done", "failed"].map((key) => (
            <Card key={key} className="bg-card">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  {key}
                </CardTitle>
                {key === "pending" && <Clock className="h-4 w-4 text-slate-500" />}
                {key === "processing" && <Clock className="h-4 w-4 text-amber-500" />}
                {key === "done" && <CheckCircle className="h-4 w-4 text-green-500" />}
                {key === "failed" && <AlertCircle className="h-4 w-4 text-red-500" />}
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{queueStats[key as keyof typeof queueStats] ?? 0}</div>
              </CardContent>
            </Card>
          ))
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-1/4" />
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
          <CardTitle>Processed Faxes</CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search records..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[40px]"></TableHead>
                <TableHead className="w-[80px]">ID</TableHead>
                <TableHead>Source File</TableHead>
                <TableHead>RX Number</TableHead>
                <TableHead>Drug Name</TableHead>
                <TableHead>Fill Date</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-10" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-10" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : filteredFaxes.length > 0 ? (
                filteredFaxes.map((fax) => {
                  const empty = isEmptyResult(fax);
                  const statusStr = fax.status as string;
                  const canReprocess = statusStr === "done" || statusStr === "error" || statusStr === "failed";
                  return (
                    <React.Fragment key={fax.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => toggleRow(fax.id)}
                      >
                        <TableCell>
                          {expandedRow === fax.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          #{fax.id}
                        </TableCell>
                        <TableCell className="font-medium max-w-[180px] truncate" title={fax.source_file || ""}>
                          {fax.source_file || "Unknown"}
                        </TableCell>
                        <TableCell>{fax.rx_number || "-"}</TableCell>
                        <TableCell>{fax.drug_name || "-"}</TableCell>
                        <TableCell>{fax.fill_date || "-"}</TableCell>
                        <TableCell>{fax.quantity || "-"}</TableCell>
                        <TableCell>
                          {fax.confidence ? `${Math.round(fax.confidence * 100)}%` : "-"}
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(fax.status, empty)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground text-sm">
                          {format(new Date(fax.created_at), "MMM d, yyyy")}
                        </TableCell>
                      </TableRow>
                      {expandedRow === fax.id && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={10} className="p-4">
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <h4 className="text-sm font-medium">Raw Extracted Text</h4>
                                {canReprocess && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={reprocessing === fax.id}
                                    onClick={(e) => { e.stopPropagation(); handleReprocess(fax.id); }}
                                  >
                                    <RefreshCw className={`h-3 w-3 mr-1.5 ${reprocessing === fax.id ? "animate-spin" : ""}`} />
                                    {reprocessing === fax.id ? "Queuing…" : "Reprocess"}
                                  </Button>
                                )}
                              </div>
                              {empty && (fax.status as string) === "done" && (
                                <div className="text-xs text-yellow-600 bg-yellow-50 border border-yellow-200 rounded p-2">
                                  OCR completed but extracted no data. This usually means the fax was a PDF with no embedded text, a blank image, or an unsupported format.
                                  Click <strong>Reprocess</strong> to try again, or check the source file.
                                </div>
                              )}
                              <pre className="bg-muted p-4 rounded-md text-xs whitespace-pre-wrap font-mono overflow-auto max-h-[300px] border border-border">
                                {fax.raw_text || "No text extracted"}
                              </pre>
                              {fax.error && (
                                <div>
                                  <h4 className="text-sm font-medium text-red-500 mb-2">Error Details</h4>
                                  <p className="text-sm text-red-500">{fax.error}</p>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                    No faxes found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
