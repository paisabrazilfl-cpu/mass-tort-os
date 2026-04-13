import React, { useState, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useListFaxResults, getListFaxResultsQueryKey, useUploadFax, useGetOcrQueueStats, getGetOcrQueueStatsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Search, Plus, AlertCircle, CheckCircle, Clock, UploadCloud, ChevronDown, ChevronRight } from "lucide-react";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

function getStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary" className="bg-slate-500/10 text-slate-500 hover:bg-slate-500/20">Pending</Badge>;
    case "processing":
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"><Clock className="w-3 h-3 mr-1" />Processing</Badge>;
    case "done":
      return <Badge variant="secondary" className="bg-green-500/10 text-green-500 hover:bg-green-500/20"><CheckCircle className="w-3 h-3 mr-1" />Done</Badge>;
    case "failed":
      return <Badge variant="destructive" className="bg-red-500/10 text-red-500 hover:bg-red-500/20"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function OcrInbox() {
  const [searchTerm, setSearchTerm] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");

  const { data: faxes = [], isLoading } = useListFaxResults();
  const { data: queueStats } = useGetOcrQueueStats({ 
    query: { refetchInterval: 5000 } 
  });
  
  const uploadMutation = useUploadFax({
    mutation: {
      onSuccess: () => {
        toast({ title: "Fax uploaded successfully" });
        queryClient.invalidateQueries({ queryKey: getListFaxResultsQueryKey() });
        setUploadOpen(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setFileName("");
      },
      onError: (err) => {
        toast({ title: "Failed to upload fax", variant: "destructive" });
        console.error(err);
      }
    }
  });

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

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">OCR Inbox</h2>
          <p className="text-muted-foreground mt-1">The Legora Grid - Process and manage incoming faxes.</p>
        </div>
        <div className="flex items-center space-x-2">
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
              </DialogHeader>
              <form onSubmit={handleUploadSubmit} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="file">Fax Image File</Label>
                  <Input id="file" type="file" accept="image/*" ref={fileInputRef} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filename">File Name Override (Optional)</Label>
                  <Input 
                    id="filename" 
                    placeholder="E.g. patient-records.png" 
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
                <TableHead className="w-[100px]">ID</TableHead>
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
                filteredFaxes.map((fax) => (
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
                      <TableCell className="font-medium max-w-[200px] truncate" title={fax.source_file || ""}>
                        {fax.source_file || "Unknown"}
                      </TableCell>
                      <TableCell>
                        {fax.rx_number || "-"}
                      </TableCell>
                      <TableCell>
                        {fax.drug_name || "-"}
                      </TableCell>
                      <TableCell>
                        {fax.fill_date || "-"}
                      </TableCell>
                      <TableCell>
                        {fax.quantity || "-"}
                      </TableCell>
                      <TableCell>
                        {fax.confidence ? `${Math.round(fax.confidence * 100)}%` : "-"}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(fax.status)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm">
                        {format(new Date(fax.created_at), "MMM d, yyyy")}
                      </TableCell>
                    </TableRow>
                    {expandedRow === fax.id && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={10} className="p-4">
                          <div className="space-y-4">
                            <div>
                              <h4 className="text-sm font-medium mb-2">Raw Extracted Text</h4>
                              <pre className="bg-muted p-4 rounded-md text-xs whitespace-pre-wrap font-mono overflow-auto max-h-[300px] border border-border">
                                {fax.raw_text || "No text extracted"}
                              </pre>
                            </div>
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
                ))
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
