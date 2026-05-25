import { type ReactNode } from "react";
import { Redirect } from "wouter";
import { usePortalAuth } from "../contexts/PortalAuthContext";

interface Props {
  children: ReactNode;
  requireMfa?: boolean;
}

export function RequireAuth({ children, requireMfa = true }: Props) {
  const { isAuthenticated, isLoading, me, tortSlug } = usePortalAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-6 w-6 border-2 border-[#1e3a5f] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to={`/${tortSlug}/login`} />;
  }

  if (requireMfa && me && !me.mfa_enabled) {
    return <Redirect to={`/${tortSlug}/mfa-setup`} />;
  }

  return <>{children}</>;
}
