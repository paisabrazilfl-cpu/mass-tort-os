import {
  ApiError,
  customFetch,
  setAuthTokenGetter,
  setOnUnauthorized,
  type CustomFetchOptions,
} from "@workspace/api-client-react";
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  getStoredUserId,
  setTokens,
} from "./auth-store";
import { getAdminUnlockToken, setAdminUnlockToken } from "./admin-unlock-store";

/**
 * A 401 with `code: "admin_locked"` is the PIN gate (super_admin needs to
 * re-enter their admin PIN), NOT a dead session. Token refresh cannot fix
 * it. Clones the response so the caller can still read the body.
 */
async function isAdminLocked401(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const clone = res.clone();
    const body = (await clone.json()) as { code?: string };
    return body?.code === "admin_locked";
  } catch {
    return false;
  }
}

export type RefreshResult = { token: string; expiresIn: number } | null;

let refreshPromise: Promise<RefreshResult> | null = null;
let onAuthFailure: (() => void) | null = null;

export function setOnAuthFailure(fn: (() => void) | null): void {
  onAuthFailure = fn;
}

setAuthTokenGetter(() => getAccessToken());

/**
 * Single-flight access-token refresh. Returns the new token + the server's
 * `expires_in` so the caller can reschedule its proactive timer. Concurrent
 * callers piggyback on the in-flight request — this is what guarantees the
 * backend's refresh-token rotation never sees the same refresh token twice
 * in parallel (which would otherwise trip its theft-detection branch and
 * revoke every session for the user).
 */
export function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise;
  const refresh = getRefreshToken();
  const userId = getStoredUserId();
  if (!refresh || userId == null) return Promise.resolve(null);

  refreshPromise = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh, user_id: userId }),
      });
      if (!res.ok) {
        clearTokens();
        return null;
      }
      const data = (await res.json()) as {
        token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!data.token || !data.refresh_token) {
        clearTokens();
        return null;
      }
      setTokens({ access: data.token, refresh: data.refresh_token, userId });
      return {
        token: data.token,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
      };
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Wire the generated React Query hooks (which call `customFetch` directly)
 * into our refresh pipeline. On 401 they will now also trigger the same
 * single-flight refresh + retry that `apiFetch` / `apiFetchRaw` use, instead
 * of failing silently and being swallowed by the QueryCache's 401 skip.
 */
setOnUnauthorized(async () => {
  const result = await refreshAccessToken();
  if (result) return result.token;
  // Refresh failed — broadcast logout so the route guard bounces us out.
  clearTokens();
  onAuthFailure?.();
  return null;
});

/**
 * Authenticated fetch wrapper around the shared `customFetch`. Adds a single
 * one-shot token refresh on 401 and broadcasts an auth-failure event when the
 * refresh itself fails so the AuthProvider can clear state and bounce the
 * user to /login.
 *
 * NOTE: With `setOnUnauthorized` wired above, `customFetch` itself now does
 * the 401 → refresh → retry dance, so this wrapper effectively just adds the
 * `onAuthFailure` broadcast. We keep it as a typed helper so call sites have
 * a place to hang error normalization (`describeError`) and a clearly named
 * entry point separate from generated hooks.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: CustomFetchOptions = {},
): Promise<T> {
  try {
    return await customFetch<T>(path, options);
  } catch (err) {
    // customFetch already attempted refresh+retry; a 401 here means refresh
    // itself failed. The setOnUnauthorized hook above already cleared tokens
    // and called onAuthFailure, so just rethrow.
    throw err;
  }
}

/**
 * Lightweight helper: stringify any thrown error (ApiError or otherwise) into
 * a user-facing message suitable for a toast `description`. Tries to surface
 * the server's `message` from the canonical envelope before falling back.
 */
export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    const data = err.data as Record<string, unknown> | undefined;
    const msg =
      (data?.message as string | undefined) ||
      (data && typeof (data as { error?: unknown }).error === "string"
        ? ((data as { error: string }).error)
        : undefined);
    return msg || err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Response-preserving fetch wrapper. Use this when a call site needs the raw
 * `Response` object (status checks, blob downloads, custom error handling)
 * instead of the parsed body that `apiFetch` returns. Auto-injects the
 * bearer token and performs a single one-shot refresh + retry on 401 via the
 * shared single-flight refresh manager.
 *
 * Drop-in replacement for `fetch` for any same-origin `/api/...` path.
 */
export async function apiFetchRaw(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const initialHeaders = new Headers(init.headers);
  const token = getAccessToken();
  if (token && !initialHeaders.has("authorization")) {
    initialHeaders.set("authorization", `Bearer ${token}`);
  }
  // Auto-attach the admin-unlock "sudo mode" token so every authed API
  // call to a PIN-gated admin route succeeds while the unlock is fresh.
  const adminUnlock = getAdminUnlockToken();
  if (adminUnlock && !initialHeaders.has("x-admin-unlock")) {
    initialHeaders.set("x-admin-unlock", adminUnlock);
  }

  let res = await fetch(input, { ...init, headers: initialHeaders });

  if (res.status !== 401) return res;

  // PIN-gated route, not a dead session — clear the stale unlock token
  // and return so the caller (AdminGate) re-prompts. Refreshing access
  // tokens would not help: the missing thing is the admin-unlock JWT.
  if (await isAdminLocked401(res)) {
    setAdminUnlockToken(null);
    return res;
  }

  const result = await refreshAccessToken();
  if (result) {
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("authorization", `Bearer ${result.token}`);
    if (adminUnlock) retryHeaders.set("x-admin-unlock", adminUnlock);
    res = await fetch(input, { ...init, headers: retryHeaders });
    if (res.status !== 401) return res;
    // Same protection on the post-refresh response.
    if (await isAdminLocked401(res)) {
      setAdminUnlockToken(null);
      return res;
    }
  }

  clearTokens();
  onAuthFailure?.();
  return res;
}

export { ApiError };
