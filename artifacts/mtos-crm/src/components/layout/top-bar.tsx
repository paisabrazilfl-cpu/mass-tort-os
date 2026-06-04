import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Menu,
  LogOut,
  User as UserIcon,
  Palette,
  Check,
  Search,
  PlusCircle,
  AppWindow,
  HeartPulse,
  Workflow,
  PhoneCall,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useAuth } from "@/contexts/auth-context";
import { useTheme, THEME_OPTIONS } from "@/contexts/theme-context";
import { navigation } from "./sidebar-nav";

interface TopBarProps {
  onOpenSidebar: () => void;
}

function initials(name?: string | null, email?: string | null): string {
  const source = (name?.trim() || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

const QUICK_ACTIONS = [
  { label: "New lead", href: "/leads/new", icon: PlusCircle },
  { label: "Forms", href: "/web-forms", icon: AppWindow },
  { label: "Med recs", href: "/medical-records", icon: HeartPulse },
  { label: "Dialer", href: "/dialer", icon: PhoneCall },
  { label: "Automations", href: "/automations", icon: Workflow },
] as const;

export function TopBar({ onOpenSidebar }: TopBarProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [, setLocation] = useLocation();
  const displayName = user?.name?.trim() || user?.email || "Signed in";
  const isSuperAdmin = user?.role === "super_admin";
  const [commandOpen, setCommandOpen] = useState(false);

  const commandGroups = useMemo(
    () =>
      navigation
        .filter((group) => !group.superAdminOnly || isSuperAdmin)
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => !item.superAdminOnly || isSuperAdmin),
        }))
        .filter((group) => group.items.length > 0),
    [isSuperAdmin],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleNavigate = (href: string) => {
    setCommandOpen(false);
    setLocation(href);
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border/70 bg-background/72 px-3 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/62 sm:px-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenSidebar}
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>

        <div className="md:hidden flex items-center gap-2">
          <span className="font-bold tracking-tight">MTOS</span>
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">v1.0</span>
        </div>

        <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full max-w-80 justify-start rounded-full border-primary/15 bg-background/70 text-muted-foreground shadow-[0_12px_30px_-24px_hsl(var(--primary)/0.55)]"
            onClick={() => setCommandOpen(true)}
            data-testid="button-global-quick-jump"
          >
            <Search className="mr-2 h-4 w-4" aria-hidden="true" />
            <span>Go anywhere…</span>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">Ctrl/⌘ K</span>
          </Button>

          <div className="hidden min-w-0 items-center gap-2 overflow-x-auto xl:flex">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <Button
                  key={action.href}
                  type="button"
                  variant="ghost"
                  className="h-10 shrink-0 gap-2 rounded-full border border-border/70 bg-background/72 px-3 shadow-[0_10px_24px_-20px_hsl(var(--foreground)/0.35)]"
                  onClick={() => handleNavigate(action.href)}
                  data-testid={`topbar-quick-action-${action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span>{action.label}</span>
                </Button>
              );
            })}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 md:hidden"
            aria-label="Quick jump"
            onClick={() => setCommandOpen(true)}
            data-testid="button-mobile-quick-jump"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Change theme" data-testid="theme-switcher">
                <Palette className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {THEME_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.id}
                  onSelect={(e) => { e.preventDefault(); setTheme(opt.id); }}
                  data-testid={`theme-option-${opt.id}`}
                >
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block h-4 w-4 rounded-full border border-border"
                    style={{ background: opt.swatch }}
                  />
                  <span className="flex-1">{opt.label}</span>
                  {theme === opt.id && <Check className="ml-2 h-3.5 w-3.5" aria-hidden="true" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-9 gap-2 px-2 sm:px-3"
                aria-label={`Account menu for ${displayName}`}
              >
                <span
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary"
                  aria-hidden="true"
                >
                  {initials(user?.name, user?.email)}
                </span>
                <span className="hidden text-left sm:flex sm:flex-col sm:leading-tight">
                  <span className="text-sm font-medium">{displayName}</span>
                  {user?.role && (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {user.role}
                    </span>
                  )}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{displayName}</span>
                  {user?.email && (
                    <span className="text-xs text-muted-foreground">{user.email}</span>
                  )}
                  {user?.role && (
                    <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {user.role}
                    </span>
                  )}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <UserIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                <span>Profile (coming soon)</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  void logout();
                }}
              >
                <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
        <CommandInput placeholder="Jump to a workspace, tool, or page…" />
        <CommandList>
          <CommandEmpty>No matching workspace found.</CommandEmpty>

          <CommandGroup heading="Quick actions">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <CommandItem key={action.href} value={action.label} onSelect={() => handleNavigate(action.href)}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span>{action.label}</span>
                  <CommandShortcut>Open</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>

          {commandGroups.map((group) => (
            <CommandGroup key={group.section} heading={group.section}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem key={`${group.section}:${item.href}`} value={`${group.section} ${item.name}`} onSelect={() => handleNavigate(item.href)}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span>{item.name}</span>
                    <CommandShortcut>{group.section}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
