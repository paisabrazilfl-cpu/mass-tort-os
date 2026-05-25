import { getAccessToken, getRefreshToken, getStoredUserId, setTokens, clearTokens } from "./auth-store";

let refreshPromise: Promise<string | null> | null = null;
let onAuthFailure: (() => void) | null = null;

export function setOnAuthFailure(fn: (() => void) | null): void {
  onAuthFailure = fn;
}

// Single-flight refresh — prevents double-rotation of the refresh token.
export function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const refresh = getRefreshToken();
  const userId = getStoredUserId();
  if (!refresh || userId == null) return Promise.resolve(null);

  refreshPromise = (async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/portal/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // portal_user_id coerced to number by zod on the server
        body: JSON.stringify({ refresh_token: refresh, portal_user_id: userId }),
      });
      if (!res.ok) { clearTokens(); return null; }
      const data = await res.json() as { token?: string; refresh_token?: string };
      if (!data.token || !data.refresh_token) { clearTokens(); return null; }
      setTokens({ access: data.token, refresh: data.refresh_token, userId });
      return data.token;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export class ApiError extends Error {
  constructor(public status: number, public data: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    const d = err.data as Record<string, unknown> | undefined;
    return (d?.message as string) || (d?.error as string) || err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// Authenticated fetch with one-shot refresh on 401.
export async function portalFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await rawFetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data, (data as { message?: string })?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Unauthenticated fetch (login, signup, etc.)
export async function publicFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data, (data as { message?: string })?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function rawFetch(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res = await fetch(path, { ...options, headers });
  if (res.status !== 401) return res;

  // Attempt refresh.
  const newToken = await refreshAccessToken();
  if (newToken) {
    const retryHeaders = new Headers(options.headers);
    if (!retryHeaders.has("Content-Type")) retryHeaders.set("Content-Type", "application/json");
    retryHeaders.set("Authorization", `Bearer ${newToken}`);
    res = await fetch(path, { ...options, headers: retryHeaders });
    if (res.status !== 401) return res;
  }

  clearTokens();
  onAuthFailure?.();
  return res;
}
