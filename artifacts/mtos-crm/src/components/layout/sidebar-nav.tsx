import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, UserCog, FileText, PlusCircle, Briefcase, Inbox, GitBranch, UserCheck,
  BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow, Building2, ShieldCheck, FileSearch,
  Clock, Sparkles, Brain, Plug, Newspaper, TrendingUp, FileUp, Scale, Building, FileSignature,
  Grid3x3, Settings, Activity, CreditCard, Phone, Skull, Workflow, Eye, BookOpen, Library, Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; adminOnly?: boolean };
type NavSection = { section: string; items: NavItem[] };

export const navigation: NavSection[] = [
  {
    section: "Overview",
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Pipeline", href: "/pipeline", icon: GitBranch },
      { name: "Analytics", href: "/analytics", icon: BarChart3 },
      { name: "User Manual", href: "/user-manual", icon: BookOpen },
    ],
  },
  {
    section: "Leads & Cases",
    items: [
      { name: "Leads", href: "/leads", icon: Users },
      { name: "New Intake", href: "/leads/new", icon: PlusCircle },
      { name: "Lead Import", href: "/lead-import", icon: FileUp },
      { name: "Cases", href: "/cases", icon: Briefcase },
      { name: "Job Queue", href: "/job-queue", icon: Activity },
      { name: "Calls", href: "/calls", icon: Phone },
      { name: "Paralegals", href: "/paralegals", icon: UserCheck },
      { name: "Review Queue", href: "/review-queue", icon: ShieldAlert },
    ],
  },
  {
    section: "Document Workflow",
    items: [
      { name: "Web Forms", href: "/web-forms", icon: AppWindow },
      { name: "Buyers", href: "/buyers", icon: Building },
      { name: "Doc Templates", href: "/document-templates", icon: FileSignature },
      { name: "Assignment Matrix", href: "/template-assignments", icon: Grid3x3 },
      { name: "Workflow Settings", href: "/workflow-settings", icon: Settings },
    ],
  },
  {
    section: "Automation",
    items: [
      { name: "Automations", href: "/automations", icon: Workflow },
      { name: "n8n / API Setup", href: "/n8n-setup", icon: Plug },
      { name: "Self-Heal (Auto-Fix)", href: "/self-heal", icon: Sparkles },
      { name: "Competitive Intel", href: "/competitive-intel", icon: Eye },
      { name: "Form API Directory", href: "/forms-api", icon: AppWindow },
    ],
  },
  {
    section: "Documents",
    items: [
      { name: "Documents", href: "/documents", icon: FileText },
      { name: "OCR Inbox", href: "/ocr-inbox", icon: Inbox },
      { name: "Doc Review", href: "/doc-review", icon: FileSearch },
      { name: "Drafting AI", href: "/drafting", icon: Sparkles },
    ],
  },
  {
    section: "Tools",
    items: [
      { name: "NPI Lookup", href: "/npi-lookup", icon: Stethoscope },
      { name: "Form Engine", href: "/form-engine", icon: AppWindow },
      { name: "Decision Engine", href: "/decision-engine", icon: Scale },
      { name: "Praxis AI", href: "/predictive", icon: Brain },
      { name: "Timeline", href: "/timeline", icon: Clock },
    ],
  },
  {
    section: "Configuration",
    items: [
      { name: "Vendors", href: "/vendors", icon: Building2 },
      { name: "Firm Settings", href: "/firm-settings", icon: Building },
      { name: "Users", href: "/users", icon: UserCog },
      { name: "Integrations", href: "/integrations", icon: Plug },
      { name: "Billing", href: "/billing", icon: CreditCard },
      { name: "Compliance", href: "/compliance", icon: Shield },
      { name: "Security", href: "/security", icon: ShieldCheck },
    ],
  },
  {
    section: "News",
    items: [
      { name: "Tort News", href: "/news", icon: Newspaper },
      { name: "Financial", href: "/financial-news", icon: TrendingUp },
      { name: "Ads Libraries", href: "/ads-libraries", icon: Library },
    ],
  },
  {
    section: "BOS-OMEGA",
    items: [
      { name: "Dark Room", href: "/dark-room", icon: Skull, adminOnly: true },
      { name: "Restore / Snapshots", href: "/admin/snapshots", icon: Camera, adminOnly: true },
    ],
  },
];

interface SidebarNavProps {
  onNavigate?: () => void;
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const [location] = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const visibleGroups = navigation
    .map((group) => ({
      ...group,
      items: group.items.filter((it) => !it.adminOnly || isAdmin),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Primary">
      {visibleGroups.map((group) => {
        const isDarkRoom = group.section === "BOS-OMEGA";
        return (
        <div key={group.section} className={cn("mb-2", isDarkRoom && "mt-4 border-t border-red-900/40 pt-2")}>
          <div className={cn(
            "px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider",
            isDarkRoom ? "text-red-500" : "text-sidebar-foreground/50",
          )}>
            {group.section}
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const isActive =
                location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "group relative flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none",
                    "transition-[background-color,color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                    "focus-visible:ring-2 focus-visible:ring-sidebar-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                    isActive
                      ? [
                          // Apple-style active pill: gradient + inner highlight + soft shadow.
                          "text-sidebar-primary-foreground",
                          "bg-[linear-gradient(180deg,hsl(var(--sidebar-primary)/0.96),hsl(var(--sidebar-primary))_60%,hsl(var(--sidebar-primary)/0.9))]",
                          "shadow-[0_1px_0_hsl(0_0%_100%/0.18)_inset,0_1px_2px_hsl(0_0%_0%/0.18),0_4px_10px_-4px_hsl(var(--sidebar-primary)/0.5)]",
                        ].join(" ")
                      : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground hover:translate-x-px",
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <item.icon
                    className={cn(
                      "mr-2.5 h-4 w-4 flex-shrink-0 transition-colors",
                      isActive
                        ? "text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/55 group-hover:text-sidebar-accent-foreground",
                    )}
                    aria-hidden="true"
                  />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </div>
        );
      })}
    </nav>
  );
}
