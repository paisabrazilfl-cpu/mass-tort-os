import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { getAccessToken, getRefreshToken, setTokens, clearTokens, subscribe } from "../lib/auth-store";
import { refreshAccessToken, setOnAuthFailure, portalFetch } from "../lib/api";

export interface PortalMe {
  id: number;
  email: string;
  name: string;
  mfa_enabled: boolean;
  mfa_verified: boolean;
  lead_id: number;
  firm_id: number;
}

interface PortalAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  me: PortalMe | null;
  tortSlug: string;
  // Stores tokens + fetches /me. Redirecting after login is the caller's responsibility.
  login: (tokens: { token: string; refresh_token: string }, userId: number) => Promise<PortalMe | null>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const PortalAuthContext = createContext<PortalAuthState | null>(null);

export function usePortalAuth(): PortalAuthState {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error("usePortalAuth must be used inside PortalAuthProvider");
  return ctx;
}

interface Props {
  children: ReactNode;
  tortSlug: string;
}

export function PortalAuthProvider({ children, tortSlug }: Props) {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!getAccessToken() && !!me;

  const fetchMe = useCallback(async (): Promise<PortalMe | null> => {
    try {
      // /me returns { user: { ... } }
      const data = await portalFetch<{ user: PortalMe }>("/api/portal/auth/me");
      return data.user;
    } catch {
      return null;
    }
  }, []);

  // Proactive token refresh ~1 min before expiry (access tokens are 15 min).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    function schedule(delayMs: number) {
      timer = setTimeout(async () => {
        const newToken = await refreshAccessToken();
        if (newToken) schedule(13 * 60 * 1000);
      }, delayMs);
    }
    schedule(13 * 60 * 1000);
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  // On mount: restore session from stored refresh token.
  useEffect(() => {
    setOnAuthFailure(() => { setMe(null); });

    const stored = getRefreshToken();
    if (!stored) { setIsLoading(false); return; }

    (async () => {
      const newToken = await refreshAccessToken();
      if (!newToken) { clearTokens(); setIsLoading(false); return; }
      const user = await fetchMe();
      setMe(user);
      setIsLoading(false);
    })();

    return subscribe(() => {
      if (!getAccessToken()) setMe(null);
    });
  }, [fetchMe]);

  const login = useCallback(async (
    tokens: { token: string; refresh_token: string },
    userId: number,
  ): Promise<PortalMe | null> => {
    setTokens({ access: tokens.token, refresh: tokens.refresh_token, userId: String(userId) });
    const user = await fetchMe();
    setMe(user);
    return user;
  }, [fetchMe]);

  const logout = useCallback(async () => {
    try {
      await portalFetch("/api/portal/auth/logout", { method: "POST" });
    } catch { /* ignore */ }
    clearTokens();
    setMe(null);
  }, []);

  const refreshMe = useCallback(async () => {
    const user = await fetchMe();
    setMe(user);
  }, [fetchMe]);

  return (
    <PortalAuthContext.Provider value={{ isAuthenticated, isLoading, me, tortSlug, login, logout, refreshMe }}>
      {children}
    </PortalAuthContext.Provider>
  );
}
