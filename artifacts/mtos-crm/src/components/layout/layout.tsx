import { useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";
import { BillingBanner } from "./billing-banner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("mtos:sidebarCollapsed") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("mtos:sidebarCollapsed", sidebarCollapsed ? "1" : "0");
    }
  }, [sidebarCollapsed]);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0 md:hidden">
          <SheetHeader className="border-b border-sidebar-border px-4 py-3">
            <SheetTitle className="text-sidebar-foreground">MTOS</SheetTitle>
            <SheetDescription className="sr-only">Primary navigation</SheetDescription>
          </SheetHeader>
          <SidebarNav onNavigate={() => setSidebarOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenSidebar={() => setSidebarOpen(true)} />
        <BillingBanner />
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
