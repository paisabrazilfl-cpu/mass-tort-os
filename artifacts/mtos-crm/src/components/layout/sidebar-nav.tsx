import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Users, UserCog, FileText, PlusCircle, Briefcase, Inbox,
  GitBranch, UserCheck, BarChart3, Shield, Stethoscope, ShieldAlert, AppWindow,
  Building2, ShieldCheck, FileSearch, Clock, Wand2, Brain, Plug, Newspaper,
  TrendingUp, FileUp, Scale, Building, FileSignature, Grid3x3, Settings,
  Activity, CreditCard, Phone, Workflow, Eye, BookOpen, Library,
  Webhook, Wrench, Search, ListChecks, Bot, Sparkles, PhoneCall,
  HeartPulse, ChevronDown, X, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";

type ColorKey =
  | "indigo" | "blue" | "amber" | "emerald" | "rose" | "sky"
  | "violet" | "orange" | "teal" | "fuchsia" | "slate" | "red";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; superAdminOnly?: boolean };
type NavSection = {
  section: string;
  icon: typeof LayoutDashboard;
  color: ColorKey;
  items: NavItem[];
  superAdminOnly?: boolean;
};

export const navigation: NavSection[] = [
  // ── DASHBOARD ───────────────────────────────────────────────────────────────
  // High-level overview — the first thing anyone opens.
  {
    section: "Dashboard",
    icon: LayoutDashboard,
    color: "indigo",
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
    color: "blue",
    items: [
      { name: "All Leads",    href: "/leads",       icon: Users      },
      { name: "New Lead",     href: "/leads/new",   icon: PlusCircle },
      { name: "Import Leads", href: "/lead-import", icon: FileUp     },
      { name: "Intake Form",  href: "/form-engine", icon: AppWindow  },
      { name: "Public Forms", href: "/web-forms",   icon: ListChecks },
      { name: "Form API",     href: "/forms-api",   icon: Library    },
      { name: "Background Check", href: "/background-check", icon: ShieldCheck },
    ],
  },

  // ── FAVORITES ───────────────────────────────────────────────────────────────
  // Personal saved links (bookmarks). Each operator manages their own list.
  {
    section: "Favorites",
    icon: Star,
    color: "amber",
    items: [
      { name: "Favorites", href: "/favorites", icon: Star },
    ],
  },

  // ── CASES ───────────────────────────────────────────────────────────────────
  // Case status, history, and the human-review backlog.
  {
    section: "Cases",
    icon: Briefcase,
    color: "amber",
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
    color: "emerald",
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
    color: "rose",
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
    color: "sky",
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
    color: "violet",
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
    color: "orange",
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
    color: "teal",
    items: [
      { name: "Automations",   href: "/automations",           icon: Workflow },
      { name: "n8n Control Panel", href: "/n8n-control",       icon: Plug, superAdminOnly: true },
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
    color: "fuchsia",
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
    color: "slate",
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
];

// Per-section accent palettes. Full literal class strings so Tailwind's content
// scanner keeps them. `dark:` variants tuned so accents read on both the white
// (light) and dark-navy (dark) sidebar backgrounds.
type Palette = {
  chip: string;       // icon "chip" behind the group icon
  label: string;      // section label color when its group owns the route
  rail: string;       // colored rail down the left of an open group
  itemActive: string; // active link background + text
  itemHover: string;  // idle link hover background + text
  iconHover: string;  // idle link icon color on hover
};

const colorThemes: Record<ColorKey, Palette> = {
  indigo: {
    chip: "bg-indigo-500/10 text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300",
    label: "text-indigo-700 dark:text-indigo-200",
    rail: "border-indigo-400/40 dark:border-indigo-400/25",
    itemActive: "bg-gradient-to-r from-indigo-700 to-indigo-800 text-white shadow-sm shadow-indigo-500/30",
    itemHover: "hover:bg-indigo-500/10 hover:text-indigo-700 dark:hover:bg-indigo-400/10 dark:hover:text-indigo-200",
    iconHover: "group-hover:text-indigo-600 dark:group-hover:text-indigo-300",
  },
  blue: {
    chip: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300",
    label: "text-blue-700 dark:text-blue-200",
    rail: "border-blue-400/40 dark:border-blue-400/25",
    itemActive: "bg-gradient-to-r from-blue-700 to-blue-800 text-white shadow-sm shadow-blue-500/30",
    itemHover: "hover:bg-blue-500/10 hover:text-blue-700 dark:hover:bg-blue-400/10 dark:hover:text-blue-200",
    iconHover: "group-hover:text-blue-600 dark:group-hover:text-blue-300",
  },
  amber: {
    chip: "bg-amber-500/10 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
    label: "text-amber-700 dark:text-amber-200",
    rail: "border-amber-400/40 dark:border-amber-400/25",
    itemActive: "bg-gradient-to-r from-amber-700 to-amber-800 text-white shadow-sm shadow-amber-500/30",
    itemHover: "hover:bg-amber-500/10 hover:text-amber-700 dark:hover:bg-amber-400/10 dark:hover:text-amber-200",
    iconHover: "group-hover:text-amber-600 dark:group-hover:text-amber-300",
  },
  emerald: {
    chip: "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300",
    label: "text-emerald-700 dark:text-emerald-200",
    rail: "border-emerald-400/40 dark:border-emerald-400/25",
    itemActive: "bg-gradient-to-r from-emerald-700 to-emerald-800 text-white shadow-sm shadow-emerald-500/30",
    itemHover: "hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-200",
    iconHover: "group-hover:text-emerald-600 dark:group-hover:text-emerald-300",
  },
  rose: {
    chip: "bg-rose-500/10 text-rose-600 dark:bg-rose-400/15 dark:text-rose-300",
    label: "text-rose-700 dark:text-rose-200",
    rail: "border-rose-400/40 dark:border-rose-400/25",
    itemActive: "bg-gradient-to-r from-rose-700 to-rose-800 text-white shadow-sm shadow-rose-500/30",
    itemHover: "hover:bg-rose-500/10 hover:text-rose-700 dark:hover:bg-rose-400/10 dark:hover:text-rose-200",
    iconHover: "group-hover:text-rose-600 dark:group-hover:text-rose-300",
  },
  sky: {
    chip: "bg-sky-500/10 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300",
    label: "text-sky-700 dark:text-sky-200",
    rail: "border-sky-400/40 dark:border-sky-400/25",
    itemActive: "bg-gradient-to-r from-sky-700 to-sky-800 text-white shadow-sm shadow-sky-500/30",
    itemHover: "hover:bg-sky-500/10 hover:text-sky-700 dark:hover:bg-sky-400/10 dark:hover:text-sky-200",
    iconHover: "group-hover:text-sky-600 dark:group-hover:text-sky-300",
  },
  violet: {
    chip: "bg-violet-500/10 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300",
    label: "text-violet-700 dark:text-violet-200",
    rail: "border-violet-400/40 dark:border-violet-400/25",
    itemActive: "bg-gradient-to-r from-violet-700 to-violet-800 text-white shadow-sm shadow-violet-500/30",
    itemHover: "hover:bg-violet-500/10 hover:text-violet-700 dark:hover:bg-violet-400/10 dark:hover:text-violet-200",
    iconHover: "group-hover:text-violet-600 dark:group-hover:text-violet-300",
  },
  orange: {
    chip: "bg-orange-500/10 text-orange-600 dark:bg-orange-400/15 dark:text-orange-300",
    label: "text-orange-700 dark:text-orange-200",
    rail: "border-orange-400/40 dark:border-orange-400/25",
    itemActive: "bg-gradient-to-r from-orange-700 to-orange-800 text-white shadow-sm shadow-orange-500/30",
    itemHover: "hover:bg-orange-500/10 hover:text-orange-700 dark:hover:bg-orange-400/10 dark:hover:text-orange-200",
    iconHover: "group-hover:text-orange-600 dark:group-hover:text-orange-300",
  },
  teal: {
    chip: "bg-teal-500/10 text-teal-600 dark:bg-teal-400/15 dark:text-teal-300",
    label: "text-teal-700 dark:text-teal-200",
    rail: "border-teal-400/40 dark:border-teal-400/25",
    itemActive: "bg-gradient-to-r from-teal-700 to-teal-800 text-white shadow-sm shadow-teal-500/30",
    itemHover: "hover:bg-teal-500/10 hover:text-teal-700 dark:hover:bg-teal-400/10 dark:hover:text-teal-200",
    iconHover: "group-hover:text-teal-600 dark:group-hover:text-teal-300",
  },
  fuchsia: {
    chip: "bg-fuchsia-500/10 text-fuchsia-600 dark:bg-fuchsia-400/15 dark:text-fuchsia-300",
    label: "text-fuchsia-700 dark:text-fuchsia-200",
    rail: "border-fuchsia-400/40 dark:border-fuchsia-400/25",
    itemActive: "bg-gradient-to-r from-fuchsia-700 to-fuchsia-800 text-white shadow-sm shadow-fuchsia-500/30",
    itemHover: "hover:bg-fuchsia-500/10 hover:text-fuchsia-700 dark:hover:bg-fuchsia-400/10 dark:hover:text-fuchsia-200",
    iconHover: "group-hover:text-fuchsia-600 dark:group-hover:text-fuchsia-300",
  },
  slate: {
    chip: "bg-slate-500/10 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
    label: "text-slate-700 dark:text-slate-200",
    rail: "border-slate-400/40 dark:border-slate-400/25",
    itemActive: "bg-gradient-to-r from-slate-700 to-slate-800 text-white shadow-sm shadow-slate-500/30",
    itemHover: "hover:bg-slate-500/10 hover:text-slate-700 dark:hover:bg-slate-400/10 dark:hover:text-slate-200",
    iconHover: "group-hover:text-slate-600 dark:group-hover:text-slate-300",
  },
  red: {
    chip: "bg-red-500/10 text-red-600 dark:bg-red-400/15 dark:text-red-300",
    label: "text-red-700 dark:text-red-200",
    rail: "border-red-400/40 dark:border-red-400/25",
    itemActive: "bg-gradient-to-r from-red-700 to-red-800 text-white shadow-sm shadow-red-500/30",
    itemHover: "hover:bg-red-500/10 hover:text-red-700 dark:hover:bg-red-400/10 dark:hover:text-red-200",
    iconHover: "group-hover:text-red-600 dark:group-hover:text-red-300",
  },
};

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
            const theme = colorThemes[group.color];
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
                  <span
                    className={cn(
                      "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors",
                      theme.chip,
                    )}
                  >
                    <group.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className={cn("flex-1 text-left", groupHasActive && theme.label)}>
                    {group.section}
                  </span>
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
                  <div
                    className={cn("mt-1 ml-3 space-y-0.5 border-l-2 pl-2.5", theme.rail)}
                    role="group"
                    aria-label={group.section}
                  >
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
                              ? theme.itemActive
                              : cn("text-sidebar-foreground/75 hover:translate-x-px", theme.itemHover),
                          )}
                          aria-current={isActive ? "page" : undefined}
                        >
                          <item.icon
                            className={cn(
                              "mr-2.5 h-3.5 w-3.5 flex-shrink-0 transition-colors",
                              isActive
                                ? "text-white"
                                : cn("text-sidebar-foreground/45", theme.iconHover),
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
