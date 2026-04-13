import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useCreateCase } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const caseSchema = z.object({
  patient_name: z.string().min(1, "Patient name is required"),
  tort_type: z.string().min(1, "Tort type is required"),
  diagnosis: z.string().optional(),
  exposure_location: z.string().optional(),
  notes: z.string().optional(),
});

type CaseFormValues = z.infer<typeof caseSchema>;

export default function CaseNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createCase = useCreateCase();

  const form = useForm<CaseFormValues>({
    resolver: zodResolver(caseSchema),
    defaultValues: {
      patient_name: "",
      tort_type: "",
      diagnosis: "",
      exposure_location: "",
      notes: "",
    },
  });

  function onSubmit(data: CaseFormValues) {
    createCase.mutate(
      { data },
      {
        onSuccess: (res) => {
          toast({
            title: "Case Created",
            description: "The case has been successfully submitted.",
          });
          setLocation(`/cases/${res.case_id}`);
        },
        onError: (error: any) => {
          toast({
            title: "Error",
            description: error.message || "Failed to create case.",
            variant: "destructive",
          });
        },
      }
    );
  }

  return (
    <div className="flex-1 space-y-6 p-8 pt-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/cases")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">Submit Case</h2>
          <p className="text-muted-foreground mt-1">Create a new case for distributed processing.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Case Information</CardTitle>
          <CardDescription>Enter the initial metadata for the case.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="patient_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Patient Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tort_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tort Type</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Camp Lejeune" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="diagnosis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Diagnosis (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Parkinson's Disease" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="exposure_location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Exposure Location (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Base housing" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Additional Notes</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Any other relevant details..." className="min-h-[100px]" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-4">
                <Button type="button" variant="outline" onClick={() => setLocation("/cases")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createCase.isPending}>
                  {createCase.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Submit Case
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
