import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery } from "@tanstack/react-query";
import { useCreateLead, useQualifyLead, useGetFormConfigs } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { apiFetchRaw } from "@/lib/api-fetch";

const formSchema = z.object({
  first_name: z.string().min(2, "First name is required"),
  last_name: z.string().min(2, "Last name is required"),
  date_of_birth: z.string().min(1, "Date of birth is required"),
  street_address: z.string().min(2, "Street address is required"),
  city: z.string().min(2, "City is required"),
  state: z.string().min(2, "State is required"),
  zip: z.string().min(5, "Zip code is required"),
  phone_primary: z.string().min(10, "Phone number is required"),
  last_4_ssn: z.string().length(4, "Must be exactly 4 digits").regex(/^\d{4}$/, "Must be 4 digits"),
  email: z.string().email().optional().or(z.literal("")),
  tort_type: z.string().min(1, "Tort type is required"),
  diagnosis: z.string().min(2, "Diagnosis is required"),
  diagnosis_date: z.string().min(1, "Diagnosis date is required"),
  diagnosis_confirmed: z.boolean(),
  was_at_location: z.boolean(),
  location_name: z.string().optional(),
  physician_first_name: z.string().min(2, "Physician first name is required"),
  physician_last_name: z.string().min(2, "Physician last name is required"),
  physician_full_address: z.string().min(5, "Physician address is required"),
  physician_contact_info: z.string().min(5, "Physician contact info is required"),
  hospital_name: z.string().min(2, "Hospital name is required"),
  hospital_fax: z.string().min(10, "Hospital fax is required"),
  hospital_contact_info: z.string().min(5, "Hospital contact info is required"),
  source: z.string().optional(),
  notes: z.string().optional(),
  law_firm: z.string().optional(),
  client_id: z.string().optional(),
  tcpa_consent: z.boolean().refine((value) => value === true, {
    message: "Claimant consent is required before submitting."
  }),
});

const CLAIMANT_CONSENT_ACKNOWLEDGMENT =
  "By checking this box and submitting this form, I knowingly, voluntarily, and affirmatively agree and attest, intending to be legally bound, that: " +
  "(1) Consent to Contact (TCPA / Automated & AI Systems) — I expressly consent to be contacted by [COMPANY], its affiliates, participating attorneys, and their authorized representatives at the telephone number(s) and email address(es) I have provided regarding my potential claim, by live persons and/or by automated and artificial-intelligence (AI) systems, including automatic telephone dialing systems, prerecorded or artificial-voice messages, AI-powered voice agents, and AI-generated or automated text (SMS/MMS) messages, even if my number appears on any state or federal Do-Not-Call registry; I understand message and data rates may apply, message frequency may vary, and I may opt out of text messages at any time by replying STOP; this consent is not a condition of any purchase or of legal representation. " +
  "(2) Electronic Communications & Signatures — I consent to receive disclosures and to transact electronically, and I agree that my electronic signature and electronic acceptance are legally binding and have the same force and effect as a handwritten signature under the federal E-SIGN Act and the Uniform Electronic Transactions Act (UETA). " +
  "(3) Affidavit / Attestation of Truth — I affirm, under penalty of perjury under the laws of the United States and of my state of residence, that all information I have provided is true, accurate, and complete to the best of my knowledge and belief, and that I have not knowingly made any false or misleading statement. " +
  "(4) Adult Capacity — I affirm that I am at least eighteen (18) years of age and legally competent to provide these consents and attestations. " +
  "(5) Indemnification — to the fullest extent permitted by law, I agree to indemnify, defend, and hold harmless [COMPANY], its affiliates, and participating attorneys and their representatives from and against any and all claims, damages, losses, liabilities, and expenses (including reasonable attorneys' fees) arising out of or relating to any false, inaccurate, incomplete, or misleading information I provide or my breach of these acknowledgments and attestations. " +
  "(6) Nationwide Validity & Severability — I intend these consents, acknowledgments, and attestations to be valid and enforceable to the maximum extent permitted in every state of the United States, and if any provision is held unenforceable in a jurisdiction, the remaining provisions shall remain in full force and effect.";

const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", 
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", 
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", 
  "WV", "WI", "WY"
];


export default function LeadIntake() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  // Fetch the live tort campaign list so this dropdown stays in sync with the
  // Form Engine. A previous version hardcoded a 10-item list which drifted as
  // soon as an operator added or deactivated a campaign in the admin UI.
  const { data: formConfigsResp } = useGetFormConfigs();
  const tortCampaigns = (formConfigsResp?.tort_campaigns ?? [])
    .filter((c) => c.active)
    .map((c) => c.label);

  const { data: leadSources = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["lead-sources"],
    queryFn: async () => {
      const res = await apiFetchRaw("/api/lead-sources");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createLead = useCreateLead();
  const qualifyLead = useQualifyLead();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      first_name: "",
      last_name: "",
      date_of_birth: "",
      street_address: "",
      city: "",
      state: "",
      zip: "",
      phone_primary: "",
      last_4_ssn: "",
      email: "",
      tort_type: "",
      diagnosis: "",
      diagnosis_date: "",
      diagnosis_confirmed: false,
      was_at_location: false,
      location_name: "",
      physician_first_name: "",
      physician_last_name: "",
      physician_full_address: "",
      physician_contact_info: "",
      hospital_name: "",
      hospital_fax: "",
      hospital_contact_info: "",
      source: "Manual Intake",
      notes: "",
      law_firm: "",
      client_id: "",
      tcpa_consent: false,
    },
  });

  const diagnosisConfirmed = form.watch("diagnosis_confirmed");
  const wasAtLocation = form.watch("was_at_location");
  const tortType = form.watch("tort_type");
  const diagnosis = form.watch("diagnosis");

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("mtos-crm-trustedform-loader")) return;
    const formEl = document.getElementById("mtos-lead-intake-form");
    if (!formEl) return;
    const script = document.createElement("script");
    script.id = "mtos-crm-trustedform-loader";
    script.async = true;
    script.src = `https://api.trustedform.com/trustedform.js?field=xxTrustedFormCertUrl&ping_field=xxTrustedFormPingUrl&use_tagged_consent=true&l=${Date.now()}${Math.random()}`;
    const firstScript = document.getElementsByTagName("script")[0];
    if (firstScript?.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
    else document.body.appendChild(script);
  }, []);

  // Only show the disqualification warning once the operator has actually
  // started filling in the medical section. Showing it on a pristine form is
  // a false alarm — both required checkboxes default to false, so the prior
  // logic flagged every empty form as "probable disqualification" before the
  // user typed a single character.
  const medicalSectionStarted = Boolean(tortType) || Boolean(diagnosis);
  const isDisqualified =
    medicalSectionStarted && (!diagnosisConfirmed || !wasAtLocation);

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const tfCert = (document.getElementById("xxTrustedFormCertUrl_0") as HTMLInputElement | null)?.value?.trim() || "";
      const tfPing = (document.getElementById("xxTrustedFormPingUrl_0") as HTMLInputElement | null)?.value?.trim() || "";
      const tfToken = (document.getElementById("xxTrustedFormCertToken_0") as HTMLInputElement | null)?.value?.trim() || "";

      if (!tfCert) {
        toast({
          title: "TrustedForm certificate missing",
          description: "TrustedForm did not populate the certificate URL. Disable blockers, reload the page, and try again.",
          variant: "destructive",
        });
        return;
      }

      const newLead = await createLead.mutateAsync({
        data: {
          ...values,
          name: `${values.first_name} ${values.last_name}`,
          email: values.email || undefined,
          location_name: values.location_name || undefined,
          source: values.source || undefined,
          notes: values.notes || undefined,
          law_firm: values.law_firm || undefined,
          client_id: values.client_id || undefined,
          ...({
            tcpa_consent: values.tcpa_consent,
            trustedform_cert_url: tfCert,
            trustedform_ping_url: tfPing || undefined,
            trustedform_cert_token: tfToken || undefined,
            trustedform_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
            trustedform_timestamp: new Date().toISOString(),
          } as any),
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
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Intake</h1>
        <p className="text-muted-foreground mt-2">
          Complete the intake form to run the Boolean Gatekeeper protocol.
        </p>
      </div>

      {isDisqualified && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Probable Disqualification</AlertTitle>
          <AlertDescription>
            Based on current inputs, this lead will likely fail the Boolean Gatekeeper protocol. You may still submit to record the rejection.
          </AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form id="mtos-lead-intake-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          
          {/* SECTION 1: Personal Information */}
          <Card>
            <CardHeader>
              <CardTitle>Personal Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="first_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="First Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="last_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Last Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="date_of_birth"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date of Birth *</FormLabel>
                      <FormControl>
                        <Input type="date" data-tf-sensitive="true" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone_primary"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone *</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="555-555-0100" {...field} />
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
                  name="last_4_ssn"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last 4 of SSN *</FormLabel>
                      <FormControl>
                        <Input placeholder="0000" maxLength={4} pattern="\d{4}" data-tf-sensitive="true" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="street_address"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Street Address *</FormLabel>
                      <FormControl>
                        <Input placeholder="123 Main St" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City *</FormLabel>
                      <FormControl>
                        <Input placeholder="City" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>State *</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="State" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {STATES.map((state) => (
                              <SelectItem key={state} value={state}>
                                {state}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="zip"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Zip *</FormLabel>
                        <FormControl>
                          <Input placeholder="Zip" maxLength={10} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* SECTION 2: Medical Information */}
          <Card>
            <CardHeader>
              <CardTitle>Medical Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="tort_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tort Campaign *</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select campaign..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {tortCampaigns.map((campaign) => (
                            <SelectItem key={campaign} value={campaign}>
                              {campaign}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="hidden md:block" />

                <FormField
                  control={form.control}
                  name="diagnosis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Diagnosis *</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Non-Hodgkin Lymphoma" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="diagnosis_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Diagnosis Date *</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="diagnosis_confirmed"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 md:col-span-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Medical diagnosis has been confirmed by a physician</FormLabel>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="was_at_location"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 md:col-span-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Client was at the qualifying location for the required duration</FormLabel>
                      </div>
                    </FormItem>
                  )}
                />

                {wasAtLocation && (
                  <FormField
                    control={form.control}
                    name="location_name"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>Location Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. MCB Camp Lejeune" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* SECTION 3: Physician Information */}
          <Card>
            <CardHeader>
              <CardTitle>Physician Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="physician_first_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Physician First Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="First Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="physician_last_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Physician Last Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Last Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="physician_full_address"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Physician Full Address *</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Full Address" className="resize-none" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="physician_contact_info"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Physician Contact Info *</FormLabel>
                      <FormControl>
                        <Input placeholder="Phone or email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* SECTION 4: Hospital Information */}
          <Card className="border-l-4 border-l-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">Hospital Information</CardTitle>
              <CardDescription className="text-destructive font-medium">
                All hospital fields are mandatory. Leads without complete hospital information will be rejected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="hospital_name"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Hospital Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Hospital Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hospital_fax"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Hospital Fax *</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="555-555-0100" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hospital_contact_info"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Hospital Contact Info *</FormLabel>
                      <FormControl>
                        <Input placeholder="Phone, email, or contact person" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Compliance</CardTitle>
              <CardDescription>
                TrustedForm and claimant consent are required before the lead can be created.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div data-tf-element-role="offer" className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4">
                <FormField
                  control={form.control}
                  name="tcpa_consent"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="flex items-start gap-3">
                          <input
                            id="tcpa_consent_box"
                            type="checkbox"
                            checked={field.value}
                            onChange={(event) => field.onChange(event.target.checked)}
                            data-tf-element-role="consent-opt-in"
                            className="mt-1 h-4 w-4 shrink-0 rounded border border-primary"
                          />
                          <label htmlFor="tcpa_consent_box" className="text-sm leading-6 text-foreground">
                            <span data-tf-element-role="consent-language">{CLAIMANT_CONSENT_ACKNOWLEDGMENT}</span>
                          </label>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <input type="hidden" name="xxTrustedFormCertUrl" id="xxTrustedFormCertUrl_0" value="" />
                <input type="hidden" name="xxTrustedFormPingUrl" id="xxTrustedFormPingUrl_0" value="" />
                <input type="hidden" name="xxTrustedFormCertToken" id="xxTrustedFormCertToken_0" value="" />
                <noscript>
                  <img src="https://api.trustedform.com/ns.gif" alt="" style={{ display: "none" }} />
                </noscript>
              </div>
            </CardContent>
          </Card>

          {/* BOTTOM SECTION */}
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 gap-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <FormField
                    control={form.control}
                    name="source"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Source</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || ""}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select lead source…" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Manual Intake">Manual Intake</SelectItem>
                            {leadSources.map(s => (
                              <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="law_firm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Law Firm</FormLabel>
                        <FormControl>
                          <Input placeholder="Referring law firm" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="client_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client ID</FormLabel>
                        <FormControl>
                          <Input placeholder="External client ID" {...field} />
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
                      <FormLabel>Notes</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Additional notes..." className="min-h-[100px]" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => setLocation("/leads")}>Cancel</Button>
            <Button type="submit" data-tf-element-role="submit" disabled={createLead.isPending || qualifyLead.isPending}>
              <span data-tf-element-role="submit-text">{createLead.isPending || qualifyLead.isPending ? "Processing..." : "Run Gatekeeper & Submit"}</span>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
