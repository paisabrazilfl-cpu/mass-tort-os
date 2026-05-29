import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, UserCog, FileText, PlusCircle, Briefcase, Inbox,
  GitBranch, UserCheck, BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow,
  Building2, ShieldCheck, FileSearch, Clock, Wand2, Brain, Plug, Newspaper,
  TrendingUp, FileUp, Scale, Building, FileSignature, Grid3x3, Settings,
  Activity, CreditCard, Phone, Workflow, Eye, BookOpen, Library,
  Webhook, Wrench, Search, ListChecks, Bot, Skull, Sparkles, PhoneCall,
  HeartPulse, ChevronDown, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; superAdminOnly?: boolean };
type NavSection = {
  section: string;
  icon: typeof LayoutDashboard;
  items: NavItem[];
  superAdminOnly?: boolean;
};

export const navigation: NavSection[] = [
  // ── DASHBOARD ───────────────────────────────────────────────────────────────
  // High-level overview — the first thing anyone opens.
  {
    section: "Dashboard",
    icon: LayoutDashboard,
    items: [
      { name: "Overview",    href: "/",            icon: LayoutDashboard },
      { name: "Pipeline",    href: "/pipeline",    icon: GitBranch       },
      { name: "Analytics",   href: "/analytics",   icon: BarChart3       },
      { name: "User Manual", href: "/user-manual", icon: BookOpen        },
    ],
  },

  // ── LEADS & INTAKE ──────────────────────────────────────────────────────────
  // Everything that brings a claimant into the system.
  {
    section: "Leads & Intake",
    icon: Users,
    items: [
      { name: "All Leads",    href: "/leads",       icon: Users      },
      { name: "New Lead",     href: "/leads/new",   icon: PlusCircle },
      { name: "Import Leads", href: "/lead-import", icon: FileUp     },
      { name: "Intake Form",  href: "/form-engine", icon: AppWindow  },
      { name: "Public Forms", href: "/web-forms",   icon: ListChecks },
      { name: "Form API",     href: "/forms-api",   icon: Library    },
    ],
  },

  // ── CASES ───────────────────────────────────────────────────────────────────
  // Case status, history, and the human-review backlog.
  {
    section: "Cases",
    icon: Briefcase,
    items: [
      { name: "Cases",        href: "/cases",        icon: Briefcase   },
      { name: "Timeline",     href: "/timeline",     icon: Clock       },
      { name: "Review Queue", href: "/review-queue", icon: ShieldAlert },
    ],
  },

  // ── CALLS & DIALER ──────────────────────────────────────────────────────────
  // Inbound/outbound calling — call center, campaigns, voice agents.
  {
    section: "Calls & Dialer",
    icon: PhoneCall,
    items: [
      { name: "Calls",        href: "/calls",        icon: Phone     },
      { name: "Dialer",       href: "/dialer",       icon: PhoneCall },
      { name: "Voice Agents", href: "/voice-agents", icon: Bot       },
    ],
  },

  // ── MEDICAL RECORDS ─────────────────────────────────────────────────────────
  // Clinical document retrieval, intake of scans, review, and provider lookup.
  {
    section: "Medical Records",
    icon: HeartPulse,
    items: [
      { name: "Medical Records", href: "/medical-records", icon: Stethoscope },
      { name: "Document Inbox",  href: "/ocr-inbox",       icon: Inbox       },
      { name: "Document Review", href: "/doc-review",      icon: FileSearch  },
      { name: "Provider Lookup", href: "/npi-lookup",      icon: HeartPulse  },
    ],
  },

  // ── DOCUMENTS ───────────────────────────────────────────────────────────────
  // Drafting, templates, and the full document library.
  {
    section: "Documents",
    icon: FileText,
    items: [
      { name: "All Documents", href: "/documents",          icon: FileText      },
      { name: "AI Drafting",   href: "/drafting",           icon: Wand2         },
      { name: "Templates",     href: "/document-templates", icon: FileSignature },
    ],
  },

  // ── AI & TOOLS ──────────────────────────────────────────────────────────────
  // Autonomous agents, qualification, and predictive scoring.
  {
    section: "AI & Tools",
    icon: Sparkles,
    items: [
      { name: "Abby",            href: "/abby",            icon: Sparkles },
      { name: "AI Agents",       href: "/ai-agents",       icon: Bot      },
      { name: "Decision Engine", href: "/decision-engine", icon: Scale    },
      { name: "Praxis AI",       href: "/predictive",      icon: Brain    },
    ],
  },

  // ── OPERATIONS ──────────────────────────────────────────────────────────────
  // Day-to-day workflow plumbing — jobs and team assignment.
  {
    section: "Operations",
    icon: Activity,
    items: [
      { name: "Job Queue",  href: "/job-queue",  icon: Activity  },
      { name: "Paralegals", href: "/paralegals", icon: UserCheck },
    ],
  },

  // ── AUTOMATION ──────────────────────────────────────────────────────────────
  // Workflows that run without a human pressing a button.
  {
    section: "Automation",
    icon: Workflow,
    items: [
      { name: "Automations",   href: "/automations",           icon: Workflow },
      { name: "Automation Docs", href: "/automation-docs",     icon: BookOpen },
      { name: "Self-Heal",     href: "/self-heal",             icon: Wrench   },
      { name: "Webhook Log",   href: "/automation-deliveries", icon: Webhook  },
      { name: "API Setup",     href: "/n8n-setup",             icon: Plug     },
    ],
  },

  // ── RESEARCH ────────────────────────────────────────────────────────────────
  // Competitive monitoring and staying current on tort/financial news.
  {
    section: "Research",
    icon: Eye,
    items: [
      { name: "Competitive Intel", href: "/competitive-intel", icon: Eye        },
      { name: "Ads Libraries",     href: "/ads-libraries",     icon: Search     },
      { name: "Tort News",         href: "/news",              icon: Newspaper  },
      { name: "Financial News",    href: "/financial-news",    icon: TrendingUp },
    ],
  },

  // ── ADMIN ───────────────────────────────────────────────────────────────────
  // Configuration you set once and rarely touch.
  {
    section: "Admin",
    icon: Settings,
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

  // ── BOS-OMEGA ───────────────────────────────────────────────────────────────
  // Owner-only control panel. Never visible to any role below super_admin.
  {
    section: "BOS-OMEGA",
    icon: Skull,
    superAdminOnly: true,
    items: [
      { name: "Dark Room", href: "/dark-room", icon: Skull, superAdminOnly: true },
    ],
  },
];

const STORAGE_KEY = "mtos:sidebarOpenGroups";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Active match: exact, or a path prefix for non-root hrefs. */
function isItemActive(location: string, href: string): boolean {
  return location === href || (href !== "/" && location.startsWith(href));
}

interface SidebarNavProps {
  onNavigate?: () => void;
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const [location] = useLocation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const [query, setQuery] = useState("");

  const visibleNav = useMemo(
    () =>
      navigation
        .filter((g) => !g.superAdminOnly || isSuperAdmin)
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => !i.superAdminOnly || isSuperAdmin),
        }))
        .filter((g) => g.items.length > 0),
    [isSuperAdmin],
  );

  // Which section contains the current route — used to keep that group open.
  const activeSection = useMemo(() => {
    for (const g of visibleNav) {
      if (g.items.some((i) => isItemActive(location, i.href))) return g.section;
    }
    return null;
  }, [visibleNav, location]);

  // Persisted open/closed state per section. Default (no saved state): only the
  // group containing the active route is open, so the menu starts short and
  // readable instead of dumping every link at once.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as Record<string, boolean>;
    } catch {
      /* ignore malformed storage */
    }
    return {};
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(openGroups));
    }
  }, [openGroups]);

  // Auto-open the group that owns the current route whenever the active
  // section changes (i.e. on navigation). After that the user may freely
  // collapse it — this effect only re-runs when the active section changes.
  useEffect(() => {
    if (activeSection) {
      setOpenGroups((prev) =>
        prev[activeSection] === true ? prev : { ...prev, [activeSection]: true },
      );
    }
  }, [activeSection]);

  const trimmed = query.trim().toLowerCase();
  const isSearching = trimmed.length > 0;

  // When searching, filter items by name and force-open any group with matches.
  const renderedNav = useMemo(() => {
    if (!isSearching) return visibleNav;
    return visibleNav
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            i.name.toLowerCase().includes(trimmed) ||
            g.section.toLowerCase().includes(trimmed),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [visibleNav, isSearching, trimmed]);

  // A group is open when: searching (force-open all matches), the user has
  // explicitly opened it, or it owns the active route and hasn't been touched
  // yet (undefined). Once toggled, the explicit true/false wins so the active
  // group can still be collapsed.
  const isGroupOpen = (section: string) =>
    isSearching ||
    openGroups[section] === true ||
    (openGroups[section] === undefined && section === activeSection);

  const toggleGroup = (section: string) =>
    setOpenGroups((prev) => {
      const open =
        prev[section] === true ||
        (prev[section] === undefined && section === activeSection);
      return { ...prev, [section]: !open };
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sidebar-nav">
      {/* Search / filter */}
      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/40"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search menu…"
            aria-label="Search menu"
            data-testid="sidebar-search"
            className={cn(
              "w-full rounded-lg border border-sidebar-border/70 bg-sidebar-accent/30",
              "py-1.5 pl-8 pr-7 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/40",
              "outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/70",
            )}
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-sidebar-foreground/50 hover:text-sidebar-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-1" aria-label="Primary">
        {renderedNav.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-sidebar-foreground/40">
            No matches for “{query.trim()}”.
          </p>
        ) : (
          renderedNav.map((group) => {
            const open = isGroupOpen(group.section);
            const groupSlug = slugify(group.section);
            const groupHasActive = group.section === activeSection;
            return (
              <div key={group.section} className="mb-0.5">
                <button
                  type="button"
                  onClick={() => !isSearching && toggleGroup(group.section)}
                  aria-expanded={open}
                  data-testid={`sidebar-group-${groupSlug}`}
                  className={cn(
                    "group/sec flex w-full items-center gap-2 rounded-lg px-2 py-1.5",
                    "text-[11px] font-semibold uppercase tracking-wider outline-none",
                    "transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/70",
                    isSearching ? "cursor-default" : "cursor-pointer hover:bg-sidebar-accent/50",
                    groupHasActive
                      ? "text-sidebar-foreground"
                      : "text-sidebar-foreground/55",
                  )}
                >
                  <group.icon className="h-3.5 w-3.5 flex-shrink-0 text-sidebar-foreground/45" aria-hidden="true" />
                  <span className="flex-1 text-left">{group.section}</span>
                  {!isSearching && (
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 flex-shrink-0 text-sidebar-foreground/40 transition-transform duration-200",
                        open ? "rotate-0" : "-rotate-90",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </button>

                {open && (
                  <div className="mt-0.5 space-y-0.5 pl-1.5" role="group" aria-label={group.section}>
                    {group.items.map((item) => {
                      const isActive = isItemActive(location, item.href);
                      return (
                        <Link
                          key={item.name}
                          href={item.href}
                          onClick={onNavigate}
                          data-testid={`sidebar-link-${slugify(item.name)}`}
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
                )}
              </div>
            );
          })
        )}
      </nav>
    </div>
  );
}
