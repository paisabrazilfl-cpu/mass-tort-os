import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, FileText, PlusCircle, Briefcase, Inbox, GitBranch, UserCheck, BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow, Building2, ShieldCheck, FileSearch, Clock, Sparkles, Brain, Plug, Newspaper, TrendingUp, FileUp, Scale, Building, FileSignature, Grid3x3, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard };
type NavSection = { section: string; items: NavItem[] };

const navigation: NavSection[] = [
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
      { name: "Paralegals", href: "/paralegals", icon: UserCheck },
      { name: "Review Queue", href: "/review-queue", icon: ShieldAlert },
    ],
  },
  {
    section: "Document Workflow",
    items: [
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

export function Sidebar() {
  const [location] = useLocation();

  return (
    <div className="flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="font-bold text-lg tracking-tight text-sidebar-foreground">MTOS</span>
        <span className="ml-2 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">v1.0</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        {navigation.map((group) => (
          <div key={group.section} className="mb-4">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              {group.section}
            </div>
            <div className="space-y-1">
              {group.items.map((item) => {
                const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={cn(
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                      "group flex items-center rounded-md px-2 py-2 text-sm font-medium"
                    )}
                  >
                    <item.icon
                      className={cn(
                        isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/70 group-hover:text-sidebar-accent-foreground",
                        "mr-3 h-5 w-5 flex-shrink-0"
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
      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-medium text-sm">
            ID
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-sidebar-foreground">Intake Director</span>
            <span className="text-xs text-sidebar-foreground/70">System Admin</span>
          </div>
        </div>
      </div>
    </div>
  );
}
