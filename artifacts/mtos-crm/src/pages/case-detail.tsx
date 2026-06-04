import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { 
  ArrowLeft, FileText, Activity, Clock, ShieldAlert,
  CheckCircle, AlertCircle, Upload, BrainCircuit, Search, Loader2
} from "lucide-react";
import { 
  useGetCase, 
  getGetCaseQueryKey, 
  useUploadCaseFile, 
  useAnalyzeCaseFiles 
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const uploadSchema = z.object({
  file_name: z.string().min(1, "File name is required"),
  content: z.string().min(1, "Document content is required"),
});

type UploadFormValues = z.infer<typeof uploadSchema>;

function getStatusBadge(status: string) {
  switch (status) {
    case "open":
      return <Badge variant="secondary" className="bg-blue-500/10 text-blue-500">Open</Badge>;
    case "processing":
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-500"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Processing</Badge>;
    case "analyzed":
      return <Badge variant="secondary" className="bg-green-500/10 text-green-500"><CheckCircle className="w-3 h-3 mr-1" />Analyzed</Badge>;
    case "failed":
      return <Badge variant="destructive" className="bg-red-500/10 text-red-500"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function getScoreColor(score: number) {
  if (score >= 80) return "text-green-500";
  if (score >= 50) return "text-amber-500";
  if (score >= 25) return "text-orange-500";
  return "text-red-500";
}

function getScoreVerdict(score: number) {
  if (score >= 80) return "Strong";
  if (score >= 50) return "Moderate";
  if (score >= 25) return "Weak";
  return "Disqualified";
}

export default function CaseDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("overview");

  const { data: caseDetail, isLoading, refetch } = useGetCase(id, {
    query: {
      enabled: !!id,
      refetchInterval: (data: any) => data?.state?.data?.case?.status === 'processing' ? 3000 : false,
    } as any
  });

  const uploadFile = useUploadCaseFile();
  const analyzeFiles = useAnalyzeCaseFiles();

  const form = useForm<UploadFormValues>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      file_name: "",
      content: "",
    },
  });

  function onUploadSubmit(data: UploadFormValues) {
    if (!id) return;
    uploadFile.mutate(
      { id, data: { ...data, content_type: "text/plain" } },
      {
        onSuccess: () => {
          toast({ title: "Document Uploaded", description: "The document has been securely stored in the vault." });
          form.reset();
          refetch();
        },
        onError: (err: any) => {
          toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
        }
      }
    );
  }

  function handleAnalyze() {
    analyzeFiles.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Analysis Queued", description: "AI extraction job has been queued." });
          refetch();
        },
        onError: (err: any) => {
          toast({ title: "Analysis Failed", description: err.message, variant: "destructive" });
        }
      }
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 p-8 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-6">
            <Skeleton className="h-[400px] w-full" />
            <Skeleton className="h-[300px] w-full" />
          </div>
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  if (!caseDetail) {
    return <div className="p-8 text-center text-muted-foreground">Case not found.</div>;
  }

  const { case: caseData, documents, analyses, audit_trail } = caseDetail;
  const latestAnalysis = analyses && analyses.length > 0 ? analyses[0] : null;

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="relative overflow-hidden rounded-[32px] border border-primary/15 bg-[linear-gradient(135deg,hsl(var(--card)/0.98),hsl(var(--accent)/0.42))] p-6 shadow-[0_18px_40px_-28px_hsl(var(--primary)/0.55)] md:p-7">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-40 w-40 rounded-full bg-primary/16 blur-3xl" />
          <div className="absolute right-0 top-0 h-44 w-44 rounded-full bg-[hsl(var(--chart-4)/0.14)] blur-3xl" />
        </div>
        <div className="relative flex flex-col gap-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex items-start gap-4">
              <Button variant="ghost" size="icon" onClick={() => setLocation("/cases")}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <span className="rounded-full border border-primary/15 bg-background/70 px-3 py-1">Case command center</span>
                  <span className="rounded-full border border-border/70 bg-background/60 px-3 py-1">{(caseData.data?.tort_type as string) || "Unknown tort"}</span>
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-3xl font-bold tracking-tight text-foreground md:text-4xl">
                      {(caseData.data?.patient_name as string) || "Unknown Patient"}
                    </h2>
                    {getStatusBadge(caseData.status)}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground font-mono">ID: {caseData.id}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:justify-end">
              <Button variant="outline" onClick={() => refetch()}>
                Refresh
              </Button>
              <Button onClick={handleAnalyze} disabled={analyzeFiles.isPending || caseData.status === 'processing'}>
                {analyzeFiles.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BrainCircuit className="mr-2 h-4 w-4" />}
                Analyze Documents
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant={activeTab === "overview" ? "default" : "outline"} size="sm" onClick={() => setActiveTab("overview")}>Overview</Button>
            <Button variant={activeTab === "documents" ? "default" : "outline"} size="sm" onClick={() => setActiveTab("documents")}>Documents</Button>
            <Button variant={activeTab === "analysis" ? "default" : "outline"} size="sm" onClick={() => setActiveTab("analysis")}>AI Analysis</Button>
            <Button variant={activeTab === "audit" ? "default" : "outline"} size="sm" onClick={() => setActiveTab("audit")}>Audit Trail</Button>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-[22px] border border-border/70 bg-background/72 p-4 backdrop-blur-xl">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</div>
              <div className="mt-2 text-lg font-semibold capitalize">{caseData.status}</div>
            </div>
            <div className="rounded-[22px] border border-border/70 bg-background/72 p-4 backdrop-blur-xl">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Documents</div>
              <div className="mt-2 text-lg font-semibold">{documents?.length || 0} files</div>
            </div>
            <div className="rounded-[22px] border border-border/70 bg-background/72 p-4 backdrop-blur-xl">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">AI verdict</div>
              <div className="mt-2 text-lg font-semibold">{latestAnalysis && latestAnalysis.score != null ? getScoreVerdict(latestAnalysis.score) : "Pending"}</div>
            </div>
            <div className="rounded-[22px] border border-border/70 bg-background/72 p-4 backdrop-blur-xl">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</div>
              <div className="mt-2 text-lg font-semibold">{format(new Date(caseData.created_at), "MMM d, yyyy")}</div>
            </div>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documents">Documents ({documents?.length || 0})</TabsTrigger>
          <TabsTrigger value="analysis">AI Analysis</TabsTrigger>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Case Metadata</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-6">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Tort Type</dt>
                    <dd className="text-sm font-semibold mt-1">{(caseData.data?.tort_type as string) || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Diagnosis</dt>
                    <dd className="text-sm font-semibold mt-1">{(caseData.data?.diagnosis as string) || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Exposure Location</dt>
                    <dd className="text-sm font-semibold mt-1">{(caseData.data?.exposure_location as string) || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created At</dt>
                    <dd className="text-sm font-semibold mt-1">{format(new Date(caseData.created_at), "PPpp")}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Notes</dt>
                    <dd className="text-sm mt-1 bg-muted/30 p-3 rounded-md min-h-[60px]">
                      {(caseData.data?.notes as string) || "No notes provided."}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Analysis Verdict</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center justify-center py-6">
                {latestAnalysis && latestAnalysis.score != null ? (
                  <>
                    <div className={`text-6xl font-black ${getScoreColor(latestAnalysis.score)}`}>
                      {latestAnalysis.score}
                    </div>
                    <div className="mt-2 text-lg font-medium text-muted-foreground uppercase tracking-widest">
                      {getScoreVerdict(latestAnalysis.score)}
                    </div>
                  </>
                ) : (
                  <div className="text-center text-muted-foreground">
                    <BrainCircuit className="h-12 w-12 mx-auto mb-4 opacity-20" />
                    <p>No analysis available.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="documents" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Vault Documents</CardTitle>
                <CardDescription>Securely stored documents for this case.</CardDescription>
              </CardHeader>
              <CardContent>
                {documents && documents.length > 0 ? (
                  <div className="space-y-4">
                    {documents.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg bg-card">
                        <div className="flex items-center gap-3">
                          <FileText className="h-8 w-8 text-primary/70" />
                          <div>
                            <p className="font-medium text-sm">{doc.file_name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{doc.file_hash}</p>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(doc.created_at), "MMM d, yyyy")}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center p-12 border border-dashed rounded-lg">
                    <FileText className="h-8 w-8 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Upload Document</CardTitle>
                <CardDescription>Paste document text for vault storage.</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onUploadSubmit)} className="space-y-4">
                    <FormField
                      control={form.control}
                      name="file_name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>File Name</FormLabel>
                          <FormControl>
                            <Input placeholder="medical_records.txt" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Document Content</FormLabel>
                          <FormControl>
                            <Textarea placeholder="Paste raw text here..." className="min-h-[200px] font-mono text-xs" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full" disabled={uploadFile.isPending}>
                      {uploadFile.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                      Upload to Vault
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analysis" className="space-y-6">
          {latestAnalysis ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Extracted Features</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {Object.entries(latestAnalysis.features || {}).map(([key, value]) => (
                      <div key={key} className="flex flex-col border-b border-border/50 pb-3 last:border-0 last:pb-0">
                        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                          {key.replace(/_/g, ' ')}
                        </span>
                        <span className="text-sm font-medium">
                          {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Analysis Metadata</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-4">
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Model</dt>
                      <dd className="text-sm font-mono mt-1">{latestAnalysis.ai_model || "Unknown"}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Context Length</dt>
                      <dd className="text-sm mt-1">{latestAnalysis.raw_text_length?.toLocaleString() || 0} characters</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Analyzed On</dt>
                      <dd className="text-sm mt-1">{format(new Date(latestAnalysis.created_at), "PPpp")}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          ) : (
             <div className="text-center p-12 border border-dashed rounded-lg">
               <BrainCircuit className="h-8 w-8 mx-auto mb-3 text-muted-foreground/50" />
               <p className="text-sm text-muted-foreground">No analysis results yet.</p>
               <Button variant="outline" className="mt-4" onClick={handleAnalyze} disabled={analyzeFiles.isPending || caseData.status === 'processing'}>
                 Run Analysis
               </Button>
             </div>
          )}
        </TabsContent>

        <TabsContent value="audit" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Audit Trail</CardTitle>
              <CardDescription>Immutable log of all case activities.</CardDescription>
            </CardHeader>
            <CardContent>
              {audit_trail && audit_trail.length > 0 ? (
                <div className="relative border-l border-border ml-3 space-y-6 pb-4">
                  {audit_trail.map((entry) => (
                    <div key={entry.id} className="relative pl-6">
                      <div className="absolute w-3 h-3 bg-primary rounded-full -left-[6.5px] top-1.5 ring-4 ring-card" />
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{entry.action}</span>
                          <span className="text-xs text-muted-foreground">{format(new Date(entry.occurred_at), "PPpp")}</span>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono mt-1">
                          IP: {entry.ip_address || "System"}
                        </div>
                        {entry.details && (
                          <pre className="mt-2 text-xs bg-muted/50 p-2 rounded overflow-x-auto">
                            {JSON.stringify(entry.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center p-6 text-muted-foreground">No audit logs found.</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
