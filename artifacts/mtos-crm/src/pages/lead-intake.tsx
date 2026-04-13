import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateLead, useQualifyLead } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters."),
  email: z.string().email("Invalid email address.").optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  tort_type: z.string().min(1, "Please select a tort type."),
  diagnosis_confirmed: z.boolean(),
  diagnosis_type: z.string().optional(),
  was_at_location: z.boolean(),
  location_name: z.string().optional(),
  source: z.string().optional(),
});

export default function LeadIntake() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const createLead = useCreateLead();
  const qualifyLead = useQualifyLead();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      tort_type: "",
      diagnosis_confirmed: false,
      diagnosis_type: "",
      was_at_location: false,
      location_name: "",
      source: "Manual Intake",
    },
  });

  const diagnosisConfirmed = form.watch("diagnosis_confirmed");
  const wasAtLocation = form.watch("was_at_location");
  
  const isDisqualified = !diagnosisConfirmed || !wasAtLocation;
  const tortType = form.watch("tort_type");

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const newLead = await createLead.mutateAsync({
        data: {
          ...values,
          email: values.email || undefined,
          phone: values.phone || undefined,
        }
      });

      if ((newLead as any)?._conflict?.output_state === "REVIEW_REQUIRED") {
        toast({
          title: "Sent to Review Queue",
          description: (newLead as any)._conflict.details?.join(". ") || "Lead flagged for manual review due to detected conflicts.",
          variant: "destructive",
        });
        setLocation("/review-queue");
        return;
      }
      
      const qualResult = await qualifyLead.mutateAsync({ id: newLead.id });
      
      toast({
        title: "Intake Submitted",
        description: `Lead created and evaluated. Result: ${qualResult.status.toUpperCase()}`,
        variant: qualResult.status === "rejected" ? "destructive" : "default",
      });
      
      setLocation(`/leads/${newLead.id}`);
    } catch (error: any) {
      const responseData = error?.response?.data;
      if (responseData?.output_state === "REJECT") {
        toast({
          title: "Lead Rejected",
          description: responseData.details?.join(". ") || responseData.error || "Lead failed conflict validation.",
          variant: "destructive",
        });
      } else if (responseData?.output_state === "REVIEW_REQUIRED") {
        toast({
          title: "Sent to Review",
          description: responseData.details?.join(". ") || "Lead flagged for manual review due to conflicts.",
        });
      } else {
        toast({
          title: "Error",
          description: responseData?.error || "Failed to submit intake form.",
          variant: "destructive",
        });
      }
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Intake</h1>
        <p className="text-muted-foreground mt-2">
          Run Boolean Gatekeeper protocol for incoming prospects.
        </p>
      </div>

      {tortType && isDisqualified && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Probable Disqualification</AlertTitle>
          <AlertDescription>
            Based on current inputs, this lead will likely fail the Boolean Gatekeeper protocol. You may still submit to record the rejection.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Prospect Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Jane Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="jane@example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="555-0100" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-4 border-t pt-4">
                <h3 className="font-medium text-lg">Qualification Gates</h3>
                
                <FormField
                  control={form.control}
                  name="tort_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tort Campaign</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select campaign..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Camp Lejeune">Camp Lejeune</SelectItem>
                          <SelectItem value="AFFF Firefighting Foam">AFFF Firefighting Foam</SelectItem>
                          <SelectItem value="Necrotizing Enterocolitis">Necrotizing Enterocolitis</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {tortType && (
                  <div className="space-y-4 bg-muted/30 p-4 rounded-md border">
                    <FormField
                      control={form.control}
                      name="diagnosis_confirmed"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel>Medical diagnosis confirmed?</FormLabel>
                            <FormDescription>
                              Does the prospect have a formal medical diagnosis for a qualifying condition?
                            </FormDescription>
                          </div>
                        </FormItem>
                      )}
                    />
                    
                    {diagnosisConfirmed && (
                      <FormField
                        control={form.control}
                        name="diagnosis_type"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Specific Diagnosis</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. Kidney Cancer" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="was_at_location"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 mt-4">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel>Location exposure confirmed?</FormLabel>
                            <FormDescription>
                              Was the prospect at the qualifying location for the required duration?
                            </FormDescription>
                          </div>
                        </FormItem>
                      )}
                    />
                    
                    {wasAtLocation && (
                      <FormField
                        control={form.control}
                        name="location_name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Specific Location</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. MCB Camp Lejeune" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" onClick={() => setLocation("/leads")}>Cancel</Button>
                <Button type="submit" disabled={createLead.isPending || qualifyLead.isPending}>
                  {createLead.isPending || qualifyLead.isPending ? "Processing..." : "Run Gatekeeper & Submit"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
