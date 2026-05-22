/**
 * Admin-unlock token store — the "sudo mode" credential for super_admin
 * actions. Persisted in sessionStorage (survives a tab reload, but not a
 * tab close), in addition to the 60-min server-side JWT TTL.
 *
 * Read by api-fetch.ts (auto-attaches the X-Admin-Unlock header on every
 * API call) and watched by <AdminGate> (re-renders when unlock state flips).
 */
const KEY = "mtos.admin_unlock";

let token: string | null = null;
const listeners = new Set<() => void>();

function loadFromStorage(): void {
  if (typeof window === "undefined") return;
  try {
    token = window.sessionStorage.getItem(KEY);
  } catch {
    /* sessionStorage may be unavailable */
  }
}
loadFromStorage();

export function getAdminUnlockToken(): string | null {
  return token;
}

export function setAdminUnlockToken(t: string | null): void {
  token = t;
  try {
    if (t) window.sessionStorage.setItem(KEY, t);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function subscribeAdminUnlock(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
