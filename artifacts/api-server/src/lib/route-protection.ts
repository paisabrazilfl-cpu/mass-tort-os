import type { IRouter, Router } from "express";
import { logger } from "./logger";

/**
 * Boot-time route table validator.
 *
 * Why this exists: a contributor adds a new handler, forgets to call
 * `requireRole` / `requirePermission`, and because the global
 * `router.use(authMiddleware)` in `routes/index.ts` only checks that the
 * caller is *some* authenticated user, the new endpoint silently becomes
 * "any logged-in viewer can hit it". This validator catches that class of
 * bug at boot — the process refuses to start if any non-public handler is
 * missing a role/permission gate.
 *
 * The walker tracks two state bits as it descends each router:
 *   - hasAuth: an `authMiddleware` layer has been mounted on this router
 *     (or inherited from a parent), so any subsequent route is authenticated.
 *   - hasGate: a `requireRole` / `requirePermission` layer has been mounted
 *     on this router (or on the route's per-handler stack), so any
 *     subsequent route has role-checked authorisation.
 *
 * For each terminal route the validator asserts (hasAuth && hasGate) unless
 * the containing router was tagged via `markPublic()`. Authentication-only
 * routes (e.g. login) live on a router whose name is in
 * AUTH_ROUTE_EXCEPTIONS.
 */

// Router-level markers. Like the auth/gate flags below, these are
// module-LOCAL `Symbol(...)` values — NOT registered through `Symbol.for(...)`.
// If they were, any other module could compute the same key from a string
// literal and stamp `markPublic` on a router it does not own, silently
// excluding all of its routes from the boot-time validator.
const PUBLIC_ROUTER_FLAG: unique symbol = Symbol("route-protection/public");
const ROUTER_LABEL_FLAG: unique symbol = Symbol("route-protection/label");
// Markers stamped on middleware functions returned by lib/rbac.ts factories.
// Function names are unreliable: esbuild renames inner named expressions
// when the same identifier appears in the outer scope, so we tag the
// returned middleware itself with a module-LOCAL symbol.
//
// Important: these symbols are NOT exported and NOT registered via Symbol.for.
// Only this module can read them, and only this module can write them through
// the markAuthMiddleware/markGateMiddleware helpers — which are themselves
// only re-exported to lib/rbac.ts via a private internal entry point. That
// keeps the validator's trust boundary inside the rbac module: no contributor
// can import a "stamp this as a gate" helper into a feature router and forge
// a passing validation.
const AUTH_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/auth");
const GATE_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/gate");

function markAuthMiddleware<F extends (...args: unknown[]) => unknown>(fn: F): F {
  (fn as unknown as Record<symbol, unknown>)[AUTH_MIDDLEWARE_FLAG] = true;
  return fn;
}

function markGateMiddleware<F extends (...args: unknown[]) => unknown>(fn: F): F {
  (fn as unknown as Record<symbol, unknown>)[GATE_MIDDLEWARE_FLAG] = true;
  return fn;
}

// Re-exported under names that only lib/rbac.ts is supposed to import. If a
// new file pulls these in, the import path itself flags it in code review.
export { markAuthMiddleware as __internal_markAuthMiddleware };
export { markGateMiddleware as __internal_markGateMiddleware };

function hasFlag(handle: unknown, flag: symbol): boolean {
  if (handle == null) return false;
  if (typeof handle !== "function" && typeof handle !== "object") return false;
  return Boolean((handle as Record<symbol, unknown>)[flag]);
}

export function markPublic<R extends IRouter>(router: R, label: string): R {
  (router as unknown as Record<symbol, unknown>)[PUBLIC_ROUTER_FLAG] = true;
  (router as unknown as Record<symbol, unknown>)[ROUTER_LABEL_FLAG] = label;
  return router;
}

export function labelRouter<R extends IRouter>(router: R, label: string): R {
  (router as unknown as Record<symbol, unknown>)[ROUTER_LABEL_FLAG] = label;
  return router;
}

// Express Router instances are CALLABLE functions (typeof === "function")
// that carry mounted properties — so we accept both "function" and "object".
// Otherwise our markPublic() / labelRouter() symbols are silently invisible
// and every router shows up as the inherited "(root)" label.
function isExpressRouterLike(router: unknown): boolean {
  return router != null && (typeof router === "object" || typeof router === "function");
}

function isPublicRouter(router: unknown): boolean {
  if (!isExpressRouterLike(router)) return false;
  return Boolean((router as Record<symbol, unknown>)[PUBLIC_ROUTER_FLAG]);
}

function routerLabel(router: unknown, fallback: string): string {
  if (isExpressRouterLike(router)) {
    const label = (router as Record<symbol, unknown>)[ROUTER_LABEL_FLAG];
    if (typeof label === "string") return label;
  }
  return fallback;
}

// Symbol-based detection ONLY. We deliberately do NOT fall back to
// Function.name / layer.name matching: a contributor could trivially defeat
// the validator by naming any noop middleware "requireRole". Symbols are
// unforgeable from outside this module.

/**
 * Auth-router routes that are deliberately unauthenticated. The route paths
 * are matched against `${METHOD} ${path}` exactly so we don't accidentally
 * exempt new login-adjacent endpoints.
 */
const AUTH_ROUTE_EXCEPTIONS = new Set([
  "POST /login",
  "POST /refresh",
  "POST /register",
]);

/**
 * Routes that REQUIRE authentication but legitimately do NOT need a role gate
 * because they act on the caller's own account or are caller-agnostic
 * utilities.
 *
 * Keys are `${routerLabel} ${METHOD} ${path}`. Every entry is a deliberate,
 * reviewed decision — adding a row here is the only way to opt out of the
 * "auth + role gate" requirement, so an SOC review can grep for this list
 * to enumerate all auth-only endpoints.
 *
 * Auth router self-service: a logged-in user can manage their own account
 * (logout, rotate password, enrol/verify/disable their own MFA, fetch
 * their own profile) regardless of role.
 *
 * Forms router utilities: form-builder config/preview lookups and pure
 * validation helpers (no DB writes, no PII enrichment).
 */
const AUTH_ONLY_ROUTES = new Set([
  "auth POST /logout",
  "auth POST /change-password",
  "auth POST /mfa/setup",
  "auth POST /mfa/verify",
  "auth POST /mfa/disable",
  "auth GET /me",
  "forms GET /config",
  "forms GET /config/:tortId",
  "forms GET /categories",
  "forms POST /validate/email",
  "forms POST /validate/address",
]);

interface RouteIssue {
  router: string;
  method: string;
  path: string;
  reason: string;
}

interface ExpressLayer {
  name?: string;
  regexp?: RegExp;
  handle?: unknown;
  route?: {
    path: string;
    stack: Array<{ name?: string; method?: string; handle?: unknown }>;
    methods: Record<string, boolean>;
  };
}

interface ExpressRouterLike {
  stack?: ExpressLayer[];
}

function classifyHandlerNames(handlers: Array<{ handle?: unknown }>): { hasAuth: boolean; hasGate: boolean } {
  let hasAuth = false;
  let hasGate = false;
  for (const h of handlers) {
    if (hasFlag(h.handle, AUTH_MIDDLEWARE_FLAG)) hasAuth = true;
    if (hasFlag(h.handle, GATE_MIDDLEWARE_FLAG)) hasGate = true;
  }
  return { hasAuth, hasGate };
}

/**
 * Walk a single router's `stack` in order. State accumulates as we descend:
 *   - When we encounter a top-level middleware layer, classify it; if it's
 *     authMiddleware or requireRole/requirePermission, set the corresponding
 *     bit for ALL subsequent layers in this router.
 *   - When we encounter a sub-router (layer.handle is itself a router),
 *     recurse with the inherited bits.
 *   - When we encounter a terminal route, classify its per-route handler
 *     stack and combine with the inherited bits.
 */
function walkRouter(
  router: ExpressRouterLike,
  inherited: { hasAuth: boolean; hasGate: boolean; isPublic: boolean; label: string },
  issues: RouteIssue[],
  counters: { checked: number; public: number; protected: number },
): void {
  const stack = router.stack ?? [];
  let { hasAuth, hasGate } = inherited;

  for (const layer of stack) {
    if (layer.route) {
      // Terminal route on THIS router.
      const route = layer.route;
      for (const method of Object.keys(route.methods)) {
        counters.checked++;
        if (inherited.isPublic) {
          counters.public++;
          continue;
        }
        // auth-router exception list (login/refresh/register)
        if (
          inherited.label === "auth" &&
          AUTH_ROUTE_EXCEPTIONS.has(`${method.toUpperCase()} ${route.path}`)
        ) {
          counters.public++;
          continue;
        }
        const perRoute = classifyHandlerNames(route.stack);
        const finalAuth = hasAuth || perRoute.hasAuth;
        const finalGate = hasGate || perRoute.hasGate;
        if (!finalAuth) {
          issues.push({
            router: inherited.label,
            method: method.toUpperCase(),
            path: route.path,
            reason: "no authMiddleware in chain",
          });
          continue;
        }
        if (!finalGate) {
          // Authenticated-only allowance for self-service / utility endpoints.
          if (AUTH_ONLY_ROUTES.has(`${inherited.label} ${method.toUpperCase()} ${route.path}`)) {
            counters.protected++;
            continue;
          }
          issues.push({
            router: inherited.label,
            method: method.toUpperCase(),
            path: route.path,
            reason: "no requireRole/requirePermission gate",
          });
          continue;
        }
        counters.protected++;
      }
      continue;
    }

    // Non-route layer: middleware OR mounted sub-router. Express routers
    // are CALLABLE functions (so they can be used as middleware) that also
    // expose a `.stack` array — `typeof` is "function", not "object", so
    // we accept either. Plain middleware functions never carry `.stack`.
    const handle = layer.handle as ExpressRouterLike | undefined;
    const isSubRouter =
      handle != null &&
      (typeof handle === "object" || typeof handle === "function") &&
      Array.isArray((handle as ExpressRouterLike).stack);

    if (isSubRouter) {
      const subLabel = routerLabel(handle, inherited.label);
      const subPublic = inherited.isPublic || isPublicRouter(handle);
      walkRouter(
        handle as ExpressRouterLike,
        { hasAuth, hasGate, isPublic: subPublic, label: subLabel },
        issues,
        counters,
      );
      continue;
    }

    // Plain middleware on this router. Update inherited state for downstream
    // siblings — express applies layers in declaration order.
    if (hasFlag(handle, AUTH_MIDDLEWARE_FLAG)) hasAuth = true;
    if (hasFlag(handle, GATE_MIDDLEWARE_FLAG)) hasGate = true;
  }
}

/**
 * Walk the parent router (the one returned by routes/index.ts) and validate
 * every leaf route. Throws on any violation.
 */
export function validateRouteTable(parent: Router): { checked: number; public: number; protected: number } {
  const issues: RouteIssue[] = [];
  const counters = { checked: 0, public: 0, protected: 0 };

  walkRouter(
    parent as unknown as ExpressRouterLike,
    { hasAuth: false, hasGate: false, isPublic: false, label: "(root)" },
    issues,
    counters,
  );

  if (issues.length > 0) {
    const lines = issues.map(i => `  - [${i.router}] ${i.method} ${i.path}: ${i.reason}`).join("\n");
    const msg = `FATAL: Route table validation failed (${issues.length} unprotected route(s)):\n${lines}`;
    logger.fatal(msg);
    throw new Error(msg);
  }

  logger.info(counters, "Route table validated");
  return counters;
}

export type ProtectedRouter = Router;

/**
 * Inspect a single express handle (a middleware function or a sub-router)
 * and report which trust-boundary stamps it carries.
 *
 * Exported under the `__internal_` prefix so external callers know they are
 * reaching into the validator's private vocabulary. The intended consumer is
 * `src/scripts/dump-route-matrix.ts`, which renders the audit doc's per-route
 * matrix; using this helper guarantees that the matrix is computed against
 * the SAME symbol identities `validateRouteTable` checks (no string-name or
 * label-list drift).
 *
 * The returned booleans are based on identity comparison against the
 * module-local `Symbol(...)` flags. Forging is impossible from outside this
 * module: the symbols are not registered with `Symbol.for()` and are not
 * exported.
 */
export function __internal_inspectLayer(handle: unknown): {
  hasAuthStamp: boolean;
  hasGateStamp: boolean;
  isPublicRouter: boolean;
  routerLabel: string | undefined;
} {
  if (handle == null || (typeof handle !== "function" && typeof handle !== "object")) {
    return { hasAuthStamp: false, hasGateStamp: false, isPublicRouter: false, routerLabel: undefined };
  }
  const bag = handle as Record<symbol, unknown>;
  const label = bag[ROUTER_LABEL_FLAG];
  return {
    hasAuthStamp: Boolean(bag[AUTH_MIDDLEWARE_FLAG]),
    hasGateStamp: Boolean(bag[GATE_MIDDLEWARE_FLAG]),
    isPublicRouter: Boolean(bag[PUBLIC_ROUTER_FLAG]),
    routerLabel: typeof label === "string" ? label : undefined,
  };
}

/**
 * The exact same auth-router exception list `validateRouteTable` consults.
 * Re-exported so the route-matrix dumper renders consistent labels.
 */
export const __internal_AUTH_ROUTE_EXCEPTIONS: ReadonlySet<string> = AUTH_ROUTE_EXCEPTIONS;
export const __internal_AUTH_ONLY_ROUTES: ReadonlySet<string> = AUTH_ONLY_ROUTES;
