import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { useGetBillingFirmStatus, getGetBillingFirmStatusQueryKey } from "@workspace/api-client-react";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

const STATUS_COPY: Record<string, { title: string; body: string }> = {
  past_due: {
    title: "Subscription past due",
    body: "Your firm's last invoice failed. Write actions are blocked until billing is restored.",
  },
  unpaid: {
    title: "Subscription unpaid",
    body: "Your firm has an unpaid invoice. Write actions are blocked until billing is restored.",
  },
  canceled: {
    title: "Subscription canceled",
    body: "Your firm's subscription is canceled. Write actions are blocked until you re-subscribe.",
  },
  incomplete: {
    title: "Subscription incomplete",
    body: "Stripe needs payment confirmation to activate this firm. Write actions remain blocked.",
  },
  incomplete_expired: {
    title: "Subscription setup expired",
    body: "The Stripe checkout link expired before payment confirmed. Start a new checkout from Billing.",
  },
};

export function BillingBanner() {
  const q = useGetBillingFirmStatus({
    query: {
      queryKey: getGetBillingFirmStatusQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  });

  const data = q.data?.data;
  if (!data || !data.has_firm) return null;
  const status = data.subscription_status ?? "";
  if (ACTIVE_STATUSES.has(status)) return null;
  const copy = STATUS_COPY[status] ?? {
    title: "Subscription inactive",
    body:
      "Your firm has no active subscription. Write actions are blocked until billing is set up.",
  };

  return (
    <div
      role="alert"
      data-testid="banner-billing-inactive"
      className="border-b border-destructive/30 bg-destructive/10 text-destructive-foreground"
    >
      <div className="mx-auto flex w-full max-w-7xl items-start gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
        <div className="flex-1 text-sm">
          <p className="font-medium text-destructive">{copy.title}</p>
          <p className="text-destructive/90">{copy.body}</p>
        </div>
        <Link
          href="/billing"
          data-testid="link-billing-banner"
          className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20"
        >
          Manage billing
        </Link>
      </div>
    </div>
  );
}
