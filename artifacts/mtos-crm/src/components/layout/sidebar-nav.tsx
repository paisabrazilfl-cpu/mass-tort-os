import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, UserCog, FileText, PlusCircle, Briefcase, Inbox,
  GitBranch, UserCheck, BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow,
  Building2, ShieldCheck, FileSearch, Clock, Wand2, Brain, Plug, Newspaper,
  TrendingUp, FileUp, Scale, Building, FileSignature, Grid3x3, Settings,
  Activity, CreditCard, Phone, Workflow, Eye, BookOpen, Library,
  Webhook, Wrench, Search, ListChecks, Bot, Skull, Sparkles, PhoneCall,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; superAdminOnly?: boolean };
type NavSection = { section: string; items: NavItem[]; superAdminOnly?: boolean };

export const navigation: NavSection[] = [
  // ── 1. HOME ────────────────────────────────────────────────────────────────
  // High-level overview — the first thing anyone opens.
  {
    section: "Home",
    items: [
      { name: "Dashboard",   href: "/",            icon: LayoutDashboard },
      { name: "Pipeline",    href: "/pipeline",    icon: GitBranch       },
      { name: "Analytics",   href: "/analytics",   icon: BarChart3       },
      { name: "User Manual", href: "/user-manual", icon: BookOpen        },
    ],
  },

  // ── 2. LEADS & CASES ───────────────────────────────────────────────────────
  // Everything that touches a claimant — intake, case status, calls.
  {
    section: "Leads & Cases",
    items: [
      { name: "All Leads",    href: "/leads",       icon: Users      },
      { name: "New Lead",     href: "/leads/new",   icon: PlusCircle },
      { name: "Import Leads", href: "/lead-import", icon: FileUp     },
      { name: "Cases",        href: "/cases",       icon: Briefcase  },
      { name: "Calls",        href: "/calls",       icon: Phone      },
    ],
  },

  // ── 2b. DIALER ─────────────────────────────────────────────────────────────
  // Enterprise internal call center — campaigns, DNC, scripts, reports.
  {
    section: "Dialer",
    items: [
      { name: "Dialer",       href: "/dialer",      icon: PhoneCall  },
    ],
  },

  // ── 3. DOCUMENTS ──────────────────────────────────────────────────────────
  // From raw scan → AI draft → signed template.
  {
    section: "Documents",
    items: [
      { name: "All Documents", href: "/documents",          icon: FileText      },
      { name: "OCR Inbox",     href: "/ocr-inbox",          icon: Inbox         },
      { name: "Doc Review",    href: "/doc-review",         icon: FileSearch    },
      { name: "AI Drafting",   href: "/drafting",           icon: Wand2         },
      { name: "Templates",     href: "/document-templates", icon: FileSignature },
    ],
  },

  // ── 4. OPERATIONS ─────────────────────────────────────────────────────────
  // Day-to-day workflow — who's working on what, what needs attention.
  {
    section: "Operations",
    items: [
      { name: "Review Queue", href: "/review-queue", icon: ShieldAlert },
      { name: "Job Queue",    href: "/job-queue",    icon: Activity    },
      { name: "Paralegals",   href: "/paralegals",   icon: UserCheck   },
      { name: "Timeline",     href: "/timeline",     icon: Clock       },
    ],
  },

  // ── 5. LEAD GEN & RESEARCH ────────────────────────────────────────────────
  // Building intake forms, studying competitors, and staying current on news.
  {
    section: "Lead Gen & Research",
    items: [
      { name: "Intake Form",       href: "/form-engine",       icon: AppWindow  },
      { name: "Public Forms",      href: "/web-forms",         icon: ListChecks },
      { name: "Form API",          href: "/forms-api",         icon: Library    },
      { name: "Competitive Intel", href: "/competitive-intel", icon: Eye        },
      { name: "Ads Libraries",     href: "/ads-libraries",     icon: Search     },
      { name: "Tort News",         href: "/news",              icon: Newspaper  },
      { name: "Financial News",    href: "/financial-news",    icon: TrendingUp },
    ],
  },

  // ── 6. AI AGENTS & CLINICAL ───────────────────────────────────────────────
  // Autonomous agents, provider lookup, case qualification, predictive scoring.
  {
    section: "AI & Clinical",
    items: [
      { name: "Abby",            href: "/abby",            icon: Sparkles    },
      { name: "AI Agents",       href: "/ai-agents",       icon: Bot         },
      { name: "NPI Lookup",      href: "/npi-lookup",      icon: Stethoscope },
      { name: "Decision Engine", href: "/decision-engine", icon: Scale       },
      { name: "Praxis AI",       href: "/predictive",      icon: Brain       },
    ],
  },

  // ── 7. AUTOMATION ─────────────────────────────────────────────────────────
  // Workflows that run without a human pressing a button.
  {
    section: "Automation",
    items: [
      { name: "Automations",  href: "/automations",           icon: Workflow },
      { name: "Self-Heal",    href: "/self-heal",             icon: Wrench   },
      { name: "Webhook Log",  href: "/automation-deliveries", icon: Webhook  },
      { name: "API Setup",    href: "/n8n-setup",             icon: Plug     },
    ],
  },

  // ── 8. SETTINGS ───────────────────────────────────────────────────────────
  // Configuration you set once and rarely touch.
  {
    section: "Settings",
    items: [
      { name: "Firm Settings",     href: "/firm-settings",        icon: Building    },
      { name: "Team Members",      href: "/users",                icon: UserCog     },
      { name: "Vendors",           href: "/vendors",              icon: Building2   },
      { name: "Buyers",            href: "/buyers",               icon: Building    },
      { name: "Assignment Matrix", href: "/template-assignments", icon: Grid3x3     },
      { name: "Workflow Settings", href: "/workflow-settings",    icon: Settings    },
      { name: "Integrations",      href: "/integrations",         icon: Plug        },
      { name: "Billing",           href: "/billing",              icon: CreditCard  },
      { name: "Compliance",        href: "/compliance",           icon: Shield      },
      { name: "Security",          href: "/security",             icon: ShieldCheck },
    ],
  },

  // ── 9. BOS-OMEGA ──────────────────────────────────────────────────────────
  // Owner-only control panel. Never visible to any role below super_admin.
  {
    section: "BOS-OMEGA",
    superAdminOnly: true,
    items: [
      { name: "Dark Room", href: "/dark-room", icon: Skull, superAdminOnly: true },
    ],
  },

];

interface SidebarNavProps {
  onNavigate?: () => void;
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const [location] = useLocation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";

  const visibleNav = navigation
    .filter((g) => !g.superAdminOnly || isSuperAdmin)
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !i.superAdminOnly || isSuperAdmin),
    }));

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Primary">
      {visibleNav.map((group) => (
          <div key={group.section} className="mb-1">
            <div
              className="px-2 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40"
            >
              {group.section}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive =
                  location === item.href ||
                  (item.href !== "/" && location.startsWith(item.href));
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
                            "text-sidebar-primary-foreground",
                            "bg-[linear-gradient(180deg,hsl(var(--sidebar-primary)/0.96),hsl(var(--sidebar-primary))_60%,hsl(var(--sidebar-primary)/0.9))]",
                            "shadow-[0_1px_0_hsl(0_0%_100%/0.18)_inset,0_1px_2px_hsl(0_0%_0%/0.18),0_4px_10px_-4px_hsl(var(--sidebar-primary)/0.5)]",
                          ].join(" ")
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground hover:translate-x-px",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <item.icon
                      className={cn(
                        "mr-2.5 h-3.5 w-3.5 flex-shrink-0 transition-colors",
                        isActive
                          ? "text-sidebar-primary-foreground"
                          : "text-sidebar-foreground/45 group-hover:text-sidebar-accent-foreground",
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
