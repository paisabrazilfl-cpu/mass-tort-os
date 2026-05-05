import { Menu, LogOut, User as UserIcon, Palette, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/auth-context";
import { useTheme, THEME_OPTIONS } from "@/contexts/theme-context";

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

export function TopBar({ onOpenSidebar }: TopBarProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const displayName = user?.name?.trim() || user?.email || "Signed in";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
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

      <div className="ml-auto flex items-center gap-2">
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
  );
}
