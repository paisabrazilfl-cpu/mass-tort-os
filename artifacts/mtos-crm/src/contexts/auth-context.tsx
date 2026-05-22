import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "@workspace/api-client-react";
import {
  clearTokens,
  getRefreshToken,
  setTokens,
} from "@/lib/auth-store";
import { apiFetch, apiFetchRaw, refreshAccessToken, setOnAuthFailure } from "@/lib/api-fetch";
import { setAdminUnlockToken } from "@/lib/admin-unlock-store";
import { startAuthentication } from "@simplewebauthn/browser";

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "attorney" | "paralegal" | "viewer" | string;
  mfa_enabled: boolean;
};

type Status = "loading" | "authed" | "guest";

export type LoginOutcome =
  | { kind: "ok" }
  | { kind: "mfa_required" }
  | { kind: "error"; code: string; message: string };

export type RegisterOutcome =
  | { kind: "pending_verification"; email: string; message: string }
  | { kind: "error"; code: string; message: string };

type Ctx = {
  user: AuthUser | null;
  status: Status;
  pendingMfa: { email: string } | null;
  login: (email: string, password: string, totpCode?: string) => Promise<LoginOutcome>;
  register: (
    email: string,
    password: string,
    name: string,
    inviteToken?: string,
  ) => Promise<RegisterOutcome>;
  verifyMfa: (totpCode: string) => Promise<LoginOutcome>;
  verifyEmail: (token: string) => Promise<LoginOutcome>;
  requestMagicLink: (email: string) => Promise<{ ok: boolean; message: string }>;
  loginWithMagicLink: (token: string, totpCode?: string) => Promise<LoginOutcome>;
  loginWithPasskey: () => Promise<LoginOutcome>;
  requestSmsCode: (email: string) => Promise<{ ok: boolean; message: string }>;
  loginWithSmsCode: (email: string, code: string, totpCode?: string) => Promise<LoginOutcome>;
  unlockAdmin: (
    pin: string,
  ) => Promise<{ kind: "ok" } | { kind: "must_change" } | { kind: "error"; message: string }>;
  changeAdminPin: (
    currentPin: string,
    newPin: string,
  ) => Promise<{ kind: "ok" } | { kind: "error"; message: string }>;
  lockAdmin: () => void;
  cancelMfa: () => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function useAuth(): Ctx {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [pendingMfa, setPendingMfa] = useState<{ email: string; password: string } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------------------------------------------------------
  // Boot: if a refresh token is in localStorage from a prior session, swap it
  // for a fresh access token immediately so subsequent API calls don't waste
  // a 401-retry round trip; then call /api/auth/me to load the user. In dev
  // the backend's auth-bypass returns the dev admin even without a token,
  // which is exactly what we want for local development.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Best-effort refresh on boot. If it fails, /me may still succeed in dev.
      if (getRefreshToken()) {
        const result = await refreshAccessToken();
        if (cancelled) return;
        if (result) scheduleRefresh(result.expiresIn);
      }
      try {
        const me = await apiFetch<AuthUser>("/api/auth/me");
        if (cancelled) return;
        setUser(me);
        setStatus("authed");
      } catch {
        if (cancelled) return;
        clearTokens();
        setUser(null);
        setStatus("guest");
      }
    })();
    return () => {
      cancelled = true;
    };
    // scheduleRefresh is stable (useCallback w/ no deps), safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Wire the api-fetch auth-failure callback so a refresh-token rotation
  // failure (or hard 401) bounces us back to /login cleanly.
  // -------------------------------------------------------------------------
  useEffect(() => {
    setOnAuthFailure(() => {
      clearRefreshTimer();
      setUser(null);
      setStatus("guest");
      setPendingMfa(null);
      setAdminUnlockToken(null);
    });
    return () => setOnAuthFailure(null);
  }, []);

  const clearRefreshTimer = () => {
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  };

  const scheduleRefresh = useCallback((expiresInSec: number) => {
    clearRefreshTimer();
    // Refresh proactively at ~80% of the token lifetime so generated React
    // Query hooks rarely see a 401. We delegate to the shared single-flight
    // refreshAccessToken() in api-fetch.ts so the timer cannot race with a
    // concurrent 401-driven refresh — the backend treats double-use of a
    // rotated refresh token as theft and revokes every session for the user.
    const ms = Math.max(60_000, Math.floor(expiresInSec * 0.8) * 1000);
    refreshTimer.current = setTimeout(async () => {
      const result = await refreshAccessToken();
      if (result) scheduleRefresh(result.expiresIn);
    }, ms);
  }, []);

  useEffect(() => () => clearRefreshTimer(), []);

  const login = useCallback(
    async (email: string, password: string, totpCode?: string): Promise<LoginOutcome> => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            ...(totpCode ? { totp_code: totpCode } : {}),
          }),
        });

        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }

        if (res.status === 423) {
          return {
            kind: "error",
            code: "account_locked",
            message:
              (typeof body.message === "string" && body.message) ||
              "Account is temporarily locked. Try again in a few minutes.",
          };
        }
        if (res.status === 429) {
          return {
            kind: "error",
            code: "rate_limited",
            message: "Too many attempts. Please wait a few minutes and try again.",
          };
        }
        // 403 + code=email_unverified is the new login-time gate (Task #56).
        // Handle this BEFORE the generic 4xx branch so we don't trample the
        // server-supplied "verify your email" copy with the bad-credentials
        // fallback. We only emit this when there is no totpCode in flight,
        // because email_unverified is checked AFTER MFA on the server, so
        // a 403 carrying a totp_code means something else (defensive).
        if (
          res.status === 403 &&
          typeof body.code === "string" &&
          body.code === "email_unverified"
        ) {
          return {
            kind: "error",
            code: "email_unverified",
            message:
              (typeof body.message === "string" && body.message) ||
              "Please verify your email address before signing in. Check your inbox for the verification link.",
          };
        }
        if (!res.ok) {
          const code = (typeof body.code === "string" ? body.code : "") || "bad_credentials";
          if (totpCode) {
            return {
              kind: "error",
              code: "invalid_totp",
              message: "Invalid 6-digit code. Please try again.",
            };
          }
          return {
            kind: "error",
            code,
            message:
              (typeof body.message === "string" && body.message) ||
              "Invalid email or password.",
          };
        }

        if (body.mfa_required === true) {
          setPendingMfa({ email, password });
          return { kind: "mfa_required" };
        }

        const userPayload = body.user as AuthUser | undefined;
        const accessToken = typeof body.token === "string" ? body.token : null;
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
        if (!userPayload || !accessToken || !refreshToken) {
          return {
            kind: "error",
            code: "bad_response",
            message: "Login response was malformed. Please retry.",
          };
        }

        setTokens({ access: accessToken, refresh: refreshToken, userId: userPayload.id });
        setUser(userPayload);
        setStatus("authed");
        setPendingMfa(null);
        scheduleRefresh(expiresIn);
        return { kind: "ok" };
      } catch {
        return {
          kind: "error",
          code: "network",
          message: "Network error — please check your connection and retry.",
        };
      }
    },
    [scheduleRefresh],
  );

  const register = useCallback(
    async (
      email: string,
      password: string,
      name: string,
      inviteToken?: string,
    ): Promise<RegisterOutcome> => {
      try {
        // Task #57: when the user arrived via /register?invite=<token>,
        // pass it through verbatim so the server binds the new account
        // to the invite's firm (and atomically claims the invite).
        // Empty/whitespace tokens are dropped so the server's optional
        // schema doesn't reject "" with a hex-shape error.
        const trimmedInvite = inviteToken?.trim();
        const payload: Record<string, unknown> = { email, password, name };
        if (trimmedInvite) {
          payload.invite_token = trimmedInvite;
        }
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }

        if (!res.ok) {
          // Backend returns { error: "..." } for 4xx (duplicate, password
          // complexity, reserved-email collisions, and the
          // authRateLimit's 429 all share this shape) and a richer
          // { code, message } envelope for the validation_failed 400.
          // Surface either user-readable string verbatim per the task
          // contract — the server already returns copy fit for direct
          // display, including the rate-limit message.
          const code =
            (typeof body.code === "string" && body.code) ||
            (res.status === 429
              ? "rate_limited"
              : res.status === 409
                ? "email_taken"
                : "registration_failed");
          const message =
            (typeof body.error === "string" && body.error) ||
            (typeof body.message === "string" && body.message) ||
            "Could not create account.";
          return { kind: "error", code, message };
        }

        // Task #56: registration no longer issues a JWT pair. The
        // backend creates a pending user row, emails a verification
        // link, and responds 202 with a check-your-email envelope. The
        // RegisterPage uses `pending_verification` to flip into a
        // success panel that tells the user to look at their inbox.
        const message =
          (typeof body.message === "string" && body.message) ||
          "Account created. Check your email for a verification link to finish signing up.";
        return { kind: "pending_verification", email, message };
      } catch {
        return {
          kind: "error",
          code: "network",
          message: "Network error — please check your connection and retry.",
        };
      }
    },
    [],
  );

  // Consume the email-verification link. Used by /verify-email page on
  // mount to swap the single-use token for a JWT pair and immediately
  // sign the user in. Mirrors the original register success path.
  const verifyEmail = useCallback(
    async (token: string): Promise<LoginOutcome> => {
      try {
        const res = await fetch(
          `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
          { method: "GET" },
        );
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (!res.ok) {
          const code = (typeof body.code === "string" && body.code) || "invalid_token";
          const message =
            (typeof body.message === "string" && body.message) ||
            (typeof body.error === "string" && body.error) ||
            "This verification link is invalid or has expired.";
          return { kind: "error", code, message };
        }

        const rawUser = body.user as
          | (Omit<AuthUser, "mfa_enabled"> & { mfa_enabled?: boolean })
          | undefined;
        const accessToken = typeof body.token === "string" ? body.token : null;
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
        if (!rawUser || !accessToken || !refreshToken) {
          return {
            kind: "error",
            code: "bad_response",
            message: "Verification response was malformed. Please retry the link.",
          };
        }
        const userPayload: AuthUser = { ...rawUser, mfa_enabled: rawUser.mfa_enabled ?? false };

        setTokens({ access: accessToken, refresh: refreshToken, userId: userPayload.id });
        setUser(userPayload);
        setStatus("authed");
        setPendingMfa(null);
        scheduleRefresh(expiresIn);
        return { kind: "ok" };
      } catch {
        return {
          kind: "error",
          code: "network",
          message: "Network error — please check your connection and retry.",
        };
      }
    },
    [scheduleRefresh],
  );

  // Magic-link (passwordless email) — request a sign-in link. The server
  // always returns the same generic body to avoid email enumeration, so
  // `ok` reflects only transport/rate-limit success, not "email exists".
  const requestMagicLink = useCallback(
    async (email: string): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await fetch("/api/auth/magic-link/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (res.status === 429) {
          return { ok: false, message: "Too many attempts. Please wait a few minutes and try again." };
        }
        if (!res.ok) {
          return {
            ok: false,
            message:
              (typeof body.message === "string" && body.message) ||
              "Could not send a sign-in link. Check the email address and retry.",
          };
        }
        return {
          ok: true,
          message:
            (typeof body.message === "string" && body.message) ||
            "If an account exists for that email, a sign-in link is on its way.",
        };
      } catch {
        return { ok: false, message: "Network error — please check your connection and retry." };
      }
    },
    [],
  );

  // Consume a magic-link token. Mirrors login()'s token handling. An
  // MFA-enabled account gets { kind: "mfa_required" } — the /auth/magic
  // page then collects the TOTP code and re-calls with totpCode set; the
  // token is not consumed server-side until the full success.
  const loginWithMagicLink = useCallback(
    async (token: string, totpCode?: string): Promise<LoginOutcome> => {
      try {
        const res = await fetch("/api/auth/magic-link/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, ...(totpCode ? { totp_code: totpCode } : {}) }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (res.status === 423) {
          return {
            kind: "error",
            code: "account_locked",
            message:
              (typeof body.message === "string" && body.message) ||
              "Account is temporarily locked. Try again in a few minutes.",
          };
        }
        if (res.status === 429) {
          return {
            kind: "error",
            code: "rate_limited",
            message: "Too many attempts. Please wait a few minutes and try again.",
          };
        }
        if (!res.ok) {
          if (totpCode) {
            return {
              kind: "error",
              code: "invalid_totp",
              message: "Invalid 6-digit code. Please try again.",
            };
          }
          const code = (typeof body.code === "string" && body.code) || "invalid_token";
          return {
            kind: "error",
            code,
            message:
              (typeof body.message === "string" && body.message) ||
              (typeof body.error === "string" && body.error) ||
              "This sign-in link is invalid or has expired.",
          };
        }

        if (body.mfa_required === true) {
          return { kind: "mfa_required" };
        }

        const userPayload = body.user as AuthUser | undefined;
        const accessToken = typeof body.token === "string" ? body.token : null;
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
        if (!userPayload || !accessToken || !refreshToken) {
          return {
            kind: "error",
            code: "bad_response",
            message: "Sign-in response was malformed. Please retry the link.",
          };
        }

        setTokens({ access: accessToken, refresh: refreshToken, userId: userPayload.id });
        setUser(userPayload);
        setStatus("authed");
        setPendingMfa(null);
        scheduleRefresh(expiresIn);
        return { kind: "ok" };
      } catch {
        return {
          kind: "error",
          code: "network",
          message: "Network error — please check your connection and retry.",
        };
      }
    },
    [scheduleRefresh],
  );

  // Passkey (WebAuthn) sign-in — a discoverable-credential ceremony: the
  // browser offers any passkey bound to this site, no username typed. A
  // verified passkey is a phishing-resistant strong factor, so it stands
  // on its own (no separate MFA step).
  const loginWithPasskey = useCallback(async (): Promise<LoginOutcome> => {
    try {
      const optRes = await fetch("/api/auth/passkey/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!optRes.ok) {
        return {
          kind: "error",
          code: "passkey_unavailable",
          message: "Couldn't start passkey sign-in. Use another method.",
        };
      }
      const optBody = (await optRes.json()) as { challengeId?: string; options?: unknown };
      if (!optBody.challengeId || !optBody.options) {
        return { kind: "error", code: "bad_response", message: "Passkey setup response was malformed." };
      }

      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: optBody.options as never });
      } catch {
        // User dismissed the prompt, or no passkey exists on this device.
        return {
          kind: "error",
          code: "passkey_cancelled",
          message: "Passkey sign-in was cancelled, or no passkey is set up on this device.",
        };
      }

      const verRes = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: optBody.challengeId, response: assertion }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await verRes.json()) as Record<string, unknown>;
      } catch {
        /* tolerate empty body */
      }
      if (verRes.status === 423) {
        return {
          kind: "error",
          code: "account_locked",
          message:
            (typeof body.message === "string" && body.message) ||
            "Account is temporarily locked. Try again in a few minutes.",
        };
      }
      if (!verRes.ok) {
        return {
          kind: "error",
          code: (typeof body.code === "string" && body.code) || "passkey_failed",
          message:
            (typeof body.message === "string" && body.message) ||
            (typeof body.error === "string" && body.error) ||
            "That passkey was not accepted.",
        };
      }
      const userPayload = body.user as AuthUser | undefined;
      const accessToken = typeof body.token === "string" ? body.token : null;
      const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
      if (!userPayload || !accessToken || !refreshToken) {
        return { kind: "error", code: "bad_response", message: "Sign-in response was malformed." };
      }
      setTokens({ access: accessToken, refresh: refreshToken, userId: userPayload.id });
      setUser(userPayload);
      setStatus("authed");
      setPendingMfa(null);
      scheduleRefresh(expiresIn);
      return { kind: "ok" };
    } catch {
      return {
        kind: "error",
        code: "network",
        message: "Network error — please check your connection and retry.",
      };
    }
  }, [scheduleRefresh]);

  // SMS one-time-code — request a code texted to the phone on the account.
  // Always-generic server response, so `ok` reflects only transport success.
  const requestSmsCode = useCallback(
    async (email: string): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await fetch("/api/auth/sms/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (res.status === 429) {
          return { ok: false, message: "Too many attempts. Please wait a few minutes and try again." };
        }
        if (!res.ok) {
          return {
            ok: false,
            message:
              (typeof body.message === "string" && body.message) ||
              "Couldn't send a code. Check the email address and retry.",
          };
        }
        return {
          ok: true,
          message:
            (typeof body.message === "string" && body.message) ||
            "If an account with a verified phone exists, a sign-in code is on its way.",
        };
      } catch {
        return { ok: false, message: "Network error — please check your connection and retry." };
      }
    },
    [],
  );

  // Exchange an SMS code for a session. Mirrors the magic-link MFA dance:
  // an MFA-enabled account gets { kind: "mfa_required" } and the caller
  // re-submits with totpCode; the code is not consumed until full success.
  const loginWithSmsCode = useCallback(
    async (email: string, code: string, totpCode?: string): Promise<LoginOutcome> => {
      try {
        const res = await fetch("/api/auth/sms/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code, ...(totpCode ? { totp_code: totpCode } : {}) }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (res.status === 423) {
          return {
            kind: "error",
            code: "account_locked",
            message:
              (typeof body.message === "string" && body.message) ||
              "Account is temporarily locked. Try again in a few minutes.",
          };
        }
        if (res.status === 429) {
          return {
            kind: "error",
            code: "rate_limited",
            message: "Too many attempts. Please wait a few minutes and try again.",
          };
        }
        if (!res.ok) {
          if (totpCode) {
            return {
              kind: "error",
              code: "invalid_totp",
              message: "Invalid 6-digit authenticator code. Please try again.",
            };
          }
          return {
            kind: "error",
            code: (typeof body.code === "string" && body.code) || "invalid_code",
            message:
              (typeof body.message === "string" && body.message) ||
              "That code is invalid or has expired.",
          };
        }
        if (body.mfa_required === true) {
          return { kind: "mfa_required" };
        }
        const userPayload = body.user as AuthUser | undefined;
        const accessToken = typeof body.token === "string" ? body.token : null;
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
        if (!userPayload || !accessToken || !refreshToken) {
          return { kind: "error", code: "bad_response", message: "Sign-in response was malformed." };
        }
        setTokens({ access: accessToken, refresh: refreshToken, userId: userPayload.id });
        setUser(userPayload);
        setStatus("authed");
        setPendingMfa(null);
        scheduleRefresh(expiresIn);
        return { kind: "ok" };
      } catch {
        return {
          kind: "error",
          code: "network",
          message: "Network error — please check your connection and retry.",
        };
      }
    },
    [scheduleRefresh],
  );

  // Admin PIN ("sudo mode") — super_admin-only step-up auth for the admin
  // area. The unlock token is stored client-side and auto-attached to API
  // calls by apiFetchRaw.
  const unlockAdmin = useCallback(
    async (
      pin: string,
    ): Promise<{ kind: "ok" } | { kind: "must_change" } | { kind: "error"; message: string }> => {
      try {
        const res = await apiFetchRaw("/api/auth/admin-pin/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (res.status === 429) {
          return { kind: "error", message: "Too many attempts. Wait a few minutes and try again." };
        }
        if (!res.ok) {
          return {
            kind: "error",
            message:
              (typeof body.message === "string" && body.message) ||
              (typeof body.error === "string" && body.error) ||
              "Invalid PIN.",
          };
        }
        if (body.must_change === true) return { kind: "must_change" };
        if (typeof body.unlock_token === "string") {
          setAdminUnlockToken(body.unlock_token);
          return { kind: "ok" };
        }
        return { kind: "error", message: "Unexpected response — please retry." };
      } catch {
        return { kind: "error", message: "Network error — please retry." };
      }
    },
    [],
  );

  const changeAdminPin = useCallback(
    async (
      currentPin: string,
      newPin: string,
    ): Promise<{ kind: "ok" } | { kind: "error"; message: string }> => {
      try {
        const res = await apiFetchRaw("/api/auth/admin-pin/change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_pin: currentPin, new_pin: newPin }),
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* tolerate empty body */
        }
        if (!res.ok) {
          return {
            kind: "error",
            message:
              (typeof body.message === "string" && body.message) ||
              (typeof body.error === "string" && body.error) ||
              "Could not change the PIN.",
          };
        }
        if (typeof body.unlock_token === "string") {
          setAdminUnlockToken(body.unlock_token);
          return { kind: "ok" };
        }
        return { kind: "error", message: "Unexpected response — please retry." };
      } catch {
        return { kind: "error", message: "Network error — please retry." };
      }
    },
    [],
  );

  const lockAdmin = useCallback(() => {
    setAdminUnlockToken(null);
  }, []);

  const verifyMfa = useCallback(
    async (totpCode: string): Promise<LoginOutcome> => {
      if (!pendingMfa) {
        return {
          kind: "error",
          code: "no_pending",
          message: "Your sign-in session expired. Please log in again.",
        };
      }
      return login(pendingMfa.email, pendingMfa.password, totpCode);
    },
    [pendingMfa, login],
  );

  const cancelMfa = useCallback(() => setPendingMfa(null), []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      // Logout should be idempotent client-side even if the server call fails
      // (e.g. the dev-bypass user has no DB row, or the network blipped).
      if (!(err instanceof ApiError)) {
        // ignore network errors — we still want to clear local state
      }
    }
    clearRefreshTimer();
    clearTokens();
    setAdminUnlockToken(null);
    setUser(null);
    setStatus("guest");
    setPendingMfa(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        status,
        pendingMfa: pendingMfa ? { email: pendingMfa.email } : null,
        login,
        register,
        verifyMfa,
        verifyEmail,
        requestMagicLink,
        loginWithMagicLink,
        loginWithPasskey,
        requestSmsCode,
        loginWithSmsCode,
        unlockAdmin,
        changeAdminPin,
        lockAdmin,
        cancelMfa,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
