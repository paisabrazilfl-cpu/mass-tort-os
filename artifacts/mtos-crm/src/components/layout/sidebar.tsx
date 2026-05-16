import { useAuth } from "@/contexts/auth-context";
import { SidebarNav } from "./sidebar-nav";
import { FavoritesPanel } from "./favorites-panel";
import { ChevronsLeft, ChevronsRight } from "lucide-react";

function initials(name?: string | null, email?: string | null): string {
  const source = (name?.trim() || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps) {
  const { user } = useAuth();

  if (collapsed) {
    return (
      <aside
        className="hidden md:flex h-full w-10 flex-col bg-sidebar border-r border-sidebar-border items-center pt-3"
        aria-label="Sidebar (collapsed)"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-sidebar-accent/60 text-sidebar-foreground/80"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="hidden md:flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border"
      aria-label="Sidebar"
    >
      <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
        <span className="font-bold text-lg tracking-tight text-sidebar-foreground">
          MTOS<span className="text-primary">v1.0</span>
        </span>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-sidebar-accent/60 text-sidebar-foreground/70"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>
      <SidebarNav />
      <FavoritesPanel />
      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-medium text-sm"
            aria-hidden="true"
          >
            {initials(user?.name, user?.email)}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="truncate text-sm font-medium text-sidebar-foreground">
              {user?.name || user?.email || "Signed in"}
            </span>
            <span className="truncate text-xs text-sidebar-foreground/70 capitalize">
              {user?.role || "User"}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
