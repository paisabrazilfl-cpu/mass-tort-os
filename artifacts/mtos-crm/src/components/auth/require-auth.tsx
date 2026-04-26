import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/auth-context";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  children: ReactNode;
}

export function RequireAuth({ children }: Props) {
  const { status } = useAuth();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (status === "guest") {
      const next = encodeURIComponent(location || "/");
      navigate(`/login?next=${next}`, { replace: true });
    }
  }, [status, location, navigate]);

  if (status === "loading") {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm space-y-3" aria-label="Loading session">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  if (status === "guest") return null;

  return <>{children}</>;
}
