import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, FileText, PlusCircle, Briefcase, Inbox, GitBranch, UserCheck,
  BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow, Building2, ShieldCheck, FileSearch,
  Clock, Sparkles, Brain, Plug, Newspaper, TrendingUp, FileUp, Scale, Building, FileSignature,
  Grid3x3, Settings, Activity, CreditCard, Phone,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard };
type NavSection = { section: string; items: NavItem[] };

export const navigation: NavSection[] = [
  {
    section: "Overview",
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Pipeline", href: "/pipeline", icon: GitBranch },
      { name: "Analytics", href: "/analytics", icon: BarChart3 },
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
    ],
  },
];

interface SidebarNavProps {
  onNavigate?: () => void;
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const [location] = useLocation();

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Primary">
      {navigation.map((group) => (
        <div key={group.section} className="mb-2">
          <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
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
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                    "group flex items-center rounded-md px-2 py-1 text-xs font-medium",
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <item.icon
                    className={cn(
                      isActive
                        ? "text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 group-hover:text-sidebar-accent-foreground",
                      "mr-2.5 h-4 w-4 flex-shrink-0",
                    )}
                    aria-hidden="true"
                  />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
