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
    <div className="relative flex h-[100dvh] overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10rem] top-[-8rem] h-80 w-80 rounded-full bg-primary/12 blur-3xl" />
        <div className="absolute right-[-8rem] top-12 h-72 w-72 rounded-full bg-[hsl(var(--chart-4)/0.12)] blur-3xl" />
        <div className="absolute bottom-[-8rem] left-1/3 h-80 w-80 rounded-full bg-[hsl(var(--chart-2)/0.1)] blur-3xl" />
      </div>
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

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
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
