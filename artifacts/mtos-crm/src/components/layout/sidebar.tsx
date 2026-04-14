import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, FileText, PlusCircle, Briefcase, Inbox, GitBranch, UserCheck, BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow, Building2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Pipeline", href: "/pipeline", icon: GitBranch },
  { name: "Leads", href: "/leads", icon: Users },
  { name: "Cases", href: "/cases", icon: Briefcase },
  { name: "Paralegals", href: "/paralegals", icon: UserCheck },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "OCR Inbox", href: "/ocr-inbox", icon: Inbox },
  { name: "NPI Lookup", href: "/npi-lookup", icon: Stethoscope },
  { name: "Review Queue", href: "/review-queue", icon: ShieldAlert },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Compliance", href: "/compliance", icon: Shield },
  { name: "Form Engine", href: "/form-engine", icon: AppWindow },
  { name: "Vendors", href: "/vendors", icon: Building2 },
  { name: "Security", href: "/security", icon: ShieldCheck },
  { name: "New Intake", href: "/leads/new", icon: PlusCircle },
];

export function Sidebar() {
  const [location] = useLocation();

  return (
    <div className="flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="font-bold text-lg tracking-tight text-sidebar-foreground">MTOS</span>
        <span className="ml-2 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">v1.0</span>
      </div>
      <nav className="flex-1 space-y-1 px-2 py-4">
        {navigation.map((item) => {
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
