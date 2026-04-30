import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { CreditCard, ExternalLink, Loader2, RefreshCw, AlertCircle } from "lucide-react";
import {
  useGetBillingState,
  useListBillingInvoices,
  useCreateBillingCheckout,
  useCreateBillingPortal,
  getGetBillingStateQueryKey,
  getListBillingInvoicesQueryKey,
  type BillingInvoice,
  type BillingCheckoutEnvelope,
  type BillingPortalEnvelope,
} from "@workspace/api-client-react";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function formatTs(secondsOrIso: number | string | null | undefined) {
  if (secondsOrIso === null || secondsOrIso === undefined) return "—";
  const d = typeof secondsOrIso === "number" ? new Date(secondsOrIso * 1000) : new Date(secondsOrIso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusBadge(status: string | null | undefined) {
  if (!status) return <Badge variant="outline">unknown</Badge>;
  if (status === "active" || status === "trialing")
    return <Badge className="bg-emerald-600 hover:bg-emerald-700">{status}</Badge>;
  if (status === "past_due") return <Badge variant="destructive">{status}</Badge>;
  if (status === "canceled" || status === "unpaid")
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

export default function BillingPage() {
  const { toast } = useToast();
  const [priceId, setPriceId] = useState<string>("");

  // Generated React Query hooks (T006): typed end-to-end via OpenAPI.
  // Both endpoints are gated by Permission.BILLING_MANAGE on the server,
  // so a 403 here means the operator's role is wrong — surface it as the
  // load error rather than retrying.
  const stateQ = useGetBillingState({
    query: {
      queryKey: getGetBillingStateQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
    },
  });
  const invoicesQ = useListBillingInvoices({
    query: {
      queryKey: getListBillingInvoicesQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
    },
  });
  const checkoutM = useCreateBillingCheckout();
  const portalM = useCreateBillingPortal();

  const state = stateQ.data?.data ?? null;
  const invoices: BillingInvoice[] = invoicesQ.data?.data ?? [];
  const loading = stateQ.isLoading || invoicesQ.isLoading;
  const error =
    (stateQ.error instanceof Error && stateQ.error.message) ||
    (invoicesQ.error instanceof Error && invoicesQ.error.message) ||
    null;
  const busy: "checkout" | "portal" | null = checkoutM.isPending
    ? "checkout"
    : portalM.isPending
      ? "portal"
      : null;

  function load() {
    void stateQ.refetch();
    void invoicesQ.refetch();
  }

  function handleSubscribe() {
    if (!priceId.trim()) {
      toast({
        title: "Price ID required",
        description: "Enter a Stripe price ID (price_…) before starting checkout.",
        variant: "destructive",
      });
      return;
    }
    const successUrl = `${window.location.origin}/billing?stripe=success`;
    const cancelUrl = `${window.location.origin}/billing?stripe=cancel`;
    checkoutM.mutate(
      {
        data: {
          price_id: priceId.trim(),
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
      },
      {
        onSuccess: (res: BillingCheckoutEnvelope) => {
          window.location.href = res.data.url;
        },
        onError: (e: unknown) => {
          toast({
            title: "Checkout failed",
            description: e instanceof Error ? e.message : "Stripe is unavailable",
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleManage() {
    const returnUrl = `${window.location.origin}/billing`;
    portalM.mutate(
      { data: { return_url: returnUrl } },
      {
        onSuccess: (res: BillingPortalEnvelope) => {
          window.location.href = res.data.url;
        },
        onError: (e: unknown) => {
          toast({
            title: "Could not open portal",
            description: e instanceof Error ? e.message : "Stripe is unavailable",
            variant: "destructive",
          });
        },
      },
    );
  }

  const isActive = state ? ACTIVE_STATUSES.has(state.subscription_status ?? "") : false;
  const hasCustomer = !!state?.stripe_customer_id;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" data-testid="page-billing">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="w-6 h-6" /> Billing
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your Stripe subscription and view invoices.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-refresh-billing">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="p-4 flex items-start gap-2 text-destructive">
            <AlertCircle className="w-5 h-5 mt-0.5" />
            <div>
              <p className="font-medium">Could not load billing state</p>
              <p className="text-sm">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Current plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !state ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : state ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Firm</Label>
                  <div className="font-medium" data-testid="text-firm-name">{state.firm_name}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Subscription status</Label>
                  <div data-testid="text-subscription-status">{statusBadge(state.subscription_status)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Current period ends</Label>
                  <div className="font-medium" data-testid="text-period-end">{formatTs(state.current_period_end)}</div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Stripe customer</Label>
                  <div className="font-mono text-xs break-all">
                    {state.stripe_customer_id ?? <span className="text-muted-foreground">— (not yet created)</span>}
                  </div>
                </div>
              </div>

              {!state.stripe_configured && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                  Stripe is not configured. An admin must add Stripe credentials in
                  <a href="/integrations" className="underline ml-1">Integrations</a> before checkout
                  or invoice fetching will work.
                </div>
              )}

              <div className="border-t pt-4 space-y-3">
                {!isActive && (
                  <div>
                    <Label htmlFor="price-id">Stripe price ID</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        id="price-id"
                        placeholder="price_…"
                        value={priceId}
                        onChange={(e) => setPriceId(e.target.value)}
                        disabled={busy !== null || !state.stripe_configured}
                        data-testid="input-price-id"
                      />
                      <Button
                        onClick={() => void handleSubscribe()}
                        disabled={busy !== null || !state.stripe_configured}
                        data-testid="button-subscribe"
                      >
                        {busy === "checkout" ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <ExternalLink className="w-4 h-4 mr-2" />
                        )}
                        Subscribe
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Find this in your Stripe dashboard under Products → Pricing.
                    </p>
                  </div>
                )}
                {hasCustomer && (
                  <Button
                    variant="outline"
                    onClick={() => void handleManage()}
                    disabled={busy !== null}
                    data-testid="button-manage-billing"
                  >
                    {busy === "portal" ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ExternalLink className="w-4 h-4 mr-2" />
                    )}
                    Manage in Stripe
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">No firm linked to your account.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-invoices">
              No invoices yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => (
                  <TableRow key={inv.id} data-testid={`row-invoice-${inv.id}`}>
                    <TableCell className="font-mono text-xs">{inv.number ?? inv.id}</TableCell>
                    <TableCell>{statusBadge(inv.status)}</TableCell>
                    <TableCell>{formatCurrency(inv.amount_due || inv.amount_paid, inv.currency)}</TableCell>
                    <TableCell className="text-xs">
                      {formatTs(inv.period_start)} → {formatTs(inv.period_end)}
                    </TableCell>
                    <TableCell className="text-xs">{formatTs(inv.created)}</TableCell>
                    <TableCell className="text-right">
                      {inv.hosted_invoice_url ? (
                        <a
                          href={inv.hosted_invoice_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center text-primary hover:underline text-sm"
                          data-testid={`link-invoice-${inv.id}`}
                        >
                          View <ExternalLink className="w-3 h-3 ml-1" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
