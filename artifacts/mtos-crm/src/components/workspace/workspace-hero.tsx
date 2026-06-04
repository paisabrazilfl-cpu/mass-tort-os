import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowRight, Sparkles, type LucideIcon } from "lucide-react";
import { Link } from "wouter";

export interface WorkspaceHeroAction {
  label: string;
  href: string;
  icon?: LucideIcon;
  variant?: "default" | "outline" | "secondary" | "ghost";
}

export interface WorkspaceHeroStep {
  title: string;
  description: string;
  icon: LucideIcon;
  href?: string;
  ctaLabel?: string;
}

interface WorkspaceHeroProps {
  eyebrow?: string;
  title: string;
  description: string;
  badge?: string;
  actions?: WorkspaceHeroAction[];
  steps?: WorkspaceHeroStep[];
  className?: string;
}

export function WorkspaceHero({
  eyebrow,
  title,
  description,
  badge,
  actions = [],
  steps = [],
  className,
}: WorkspaceHeroProps) {
  return (
    <Card className={cn("relative overflow-hidden border-primary/15 bg-[linear-gradient(135deg,hsl(var(--card)/0.98),hsl(var(--accent)/0.55))]", className)}>
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-16 top-0 h-48 w-48 rounded-full bg-primary/18 blur-3xl" />
        <div className="absolute right-0 top-0 h-56 w-56 rounded-full bg-[hsl(var(--chart-4)/0.16)] blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-[hsl(var(--chart-2)/0.14)] blur-3xl" />
      </div>

      <CardHeader className="relative gap-5 md:flex-row md:items-end md:justify-between md:space-y-0">
        <div className="max-w-3xl space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {eyebrow ? <Badge variant="secondary" className="rounded-full px-3 py-1">{eyebrow}</Badge> : null}
            {badge ? <Badge variant="outline" className="rounded-full border-primary/20 bg-background/70 px-3 py-1">{badge}</Badge> : null}
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/15 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Fast path workspace
            </span>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-3xl leading-tight md:text-4xl">{title}</CardTitle>
            <CardDescription className="max-w-2xl text-sm leading-6 md:text-base">{description}</CardDescription>
          </div>
          {actions.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <Button key={`${action.label}-${action.href}`} variant={action.variant ?? "default"} size="sm" asChild>
                    <Link href={action.href}>
                      {Icon ? <Icon className="mr-1.5 h-4 w-4" /> : null}
                      {action.label}
                    </Link>
                  </Button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="relative grid w-full max-w-sm gap-3 rounded-[24px] border border-primary/15 bg-background/70 p-4 shadow-[0_10px_30px_-18px_hsl(var(--primary)/0.45)] backdrop-blur-xl">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Designed for low-click flow</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl border border-border/70 bg-background/80 p-3">
              <div className="text-lg font-bold text-primary">1</div>
              <div className="text-[11px] text-muted-foreground">Primary path</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-3">
              <div className="text-lg font-bold text-[hsl(var(--chart-4))]">2</div>
              <div className="text-[11px] text-muted-foreground">Next best move</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-3">
              <div className="text-lg font-bold text-[hsl(var(--chart-2))]">0</div>
              <div className="text-[11px] text-muted-foreground">Menu hunting</div>
            </div>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            Operators should feel where to go next the moment the page opens. This header keeps the path visible.
          </p>
        </div>
      </CardHeader>

      {steps.length > 0 ? (
        <CardContent className="relative">
          <div className="grid gap-3 md:grid-cols-3">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const body = (
                <div className="group h-full rounded-[24px] border border-border/70 bg-background/72 p-4 shadow-[0_12px_30px_-22px_hsl(var(--foreground)/0.25)] backdrop-blur-xl transition-transform duration-200 hover:-translate-y-1">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/12 text-primary">
                      {index + 1}
                    </span>
                    Step {index + 1}
                  </div>
                  <div className="mt-4 flex items-start gap-3">
                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,hsl(var(--primary)/0.16),hsl(var(--chart-4)/0.16))] text-primary shadow-[0_8px_20px_-14px_hsl(var(--primary)/0.45)] shrink-0">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="font-semibold">{step.title}</div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.description}</p>
                      {step.href ? (
                        <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
                          {step.ctaLabel ?? "Open"}
                          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
              return step.href ? (
                <Link key={`${step.title}-${index}`} href={step.href} className="block h-full">
                  {body}
                </Link>
              ) : (
                <div key={`${step.title}-${index}`} className="h-full">
                  {body}
                </div>
              );
            })}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
