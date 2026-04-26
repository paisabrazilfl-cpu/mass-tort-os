const REFRESH_KEY = "mtos.refresh";
const USER_ID_KEY = "mtos.uid";

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _userId: number | null = null;
const listeners = new Set<() => void>();

function loadFromStorage() {
  if (typeof window === "undefined") return;
  try {
    _refreshToken = window.localStorage.getItem(REFRESH_KEY);
    const uid = window.localStorage.getItem(USER_ID_KEY);
    _userId = uid ? Number(uid) : null;
    if (_userId !== null && Number.isNaN(_userId)) _userId = null;
  } catch {
    /* storage may be unavailable in private mode */
  }
}

loadFromStorage();

export function getAccessToken(): string | null {
  return _accessToken;
}

export function getRefreshToken(): string | null {
  return _refreshToken;
}

export function getStoredUserId(): number | null {
  return _userId;
}

export function setTokens(opts: { access: string; refresh: string; userId: number }): void {
  _accessToken = opts.access;
  _refreshToken = opts.refresh;
  _userId = opts.userId;
  try {
    window.localStorage.setItem(REFRESH_KEY, opts.refresh);
    window.localStorage.setItem(USER_ID_KEY, String(opts.userId));
  } catch {
    /* ignore */
  }
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
  } catch {
    /* ignore */
  }
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}
