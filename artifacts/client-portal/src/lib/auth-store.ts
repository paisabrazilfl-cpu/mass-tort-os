// Separate key namespace from the CRM (mtos.*) to avoid collisions.
const REFRESH_KEY = "portal.refresh";
const USER_ID_KEY = "portal.uid";

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _userId: string | null = null;

const listeners = new Set<() => void>();

function loadFromStorage() {
  if (typeof window === "undefined") return;
  try {
    _refreshToken = window.localStorage.getItem(REFRESH_KEY);
    _userId = window.localStorage.getItem(USER_ID_KEY);
  } catch {
    /* storage unavailable in private mode */
  }
}

loadFromStorage();

export function getAccessToken(): string | null { return _accessToken; }
export function getRefreshToken(): string | null { return _refreshToken; }
export function getStoredUserId(): string | null { return _userId; }

export function setTokens(opts: { access: string; refresh: string; userId: string }): void {
  _accessToken = opts.access;
  _refreshToken = opts.refresh;
  _userId = opts.userId;
  try {
    window.localStorage.setItem(REFRESH_KEY, opts.refresh);
    window.localStorage.setItem(USER_ID_KEY, opts.userId);
  } catch { /* ignore */ }
  emit();
}

export function setAccessToken(token: string | null): void {
  _accessToken = token;
  emit();
}

export function clearTokens(): void {
  _accessToken = null;
  _refreshToken = null;
  _userId = null;
  try {
    window.localStorage.removeItem(REFRESH_KEY);
    window.localStorage.removeItem(USER_ID_KEY);
  } catch { /* ignore */ }
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(): void {
  for (const fn of listeners) fn();
}
