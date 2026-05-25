import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";
import { ShieldCheck, FileText, Stethoscope, LayoutDashboard, LogOut } from "lucide-react";
import { cn } from "../lib/cn";

interface Props {
  children: ReactNode;
}

export function PortalLayout({ children }: Props) {
  const { me, logout, tortSlug } = usePortalAuth();
  const [location] = useLocation();

  const base = `/${tortSlug}`;

  const nav = [
    { href: `${base}/dashboard`, label: "My Case", icon: LayoutDashboard },
    { href: `${base}/documents`, label: "Documents", icon: FileText },
    { href: `${base}/records`, label: "Medical Records", icon: Stethoscope },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Top bar */}
      <header className="bg-[#1e3a5f] text-white shadow-md">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-300" />
            <span className="font-semibold text-sm">Secure Client Portal</span>
          </div>
          {me && (
            <div className="flex items-center gap-4">
              <span className="text-sm text-blue-200 hidden sm:block">{me.name || me.email}</span>
              <button
                onClick={() => void logout()}
                className="flex items-center gap-1 text-sm text-blue-200 hover:text-white transition-colors"
              >
                <LogOut className="h-4 w-4" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Nav tabs */}
      <nav className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 flex gap-0">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = location.startsWith(href.replace(`/${tortSlug}`, ""));
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                  active
                    ? "border-[#1e3a5f] text-[#1e3a5f]"
                    : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-6">
        {children}
      </main>

      {/* HIPAA footer */}
      <footer className="border-t border-slate-200 bg-white py-4 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-center gap-2 text-xs text-slate-400">
          <ShieldCheck className="h-3 w-3" />
          <span>HIPAA-compliant secure portal — all activity is audited</span>
        </div>
      </footer>
    </div>
  );
}
