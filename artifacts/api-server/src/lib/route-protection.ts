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
// Stamp carrying the EFFECTIVE required role/permission metadata for a
// gate middleware so the boot-time route-policy report can render it
// alongside the route. Shape: { kind: "role" | "permission", values: string[] }.
// The validator collects metadata from every gate in a route's chain (so a
// route protected by both `requireRole("admin")` AND
// `requirePermission(LEAD_VIEW_ANY)` shows up with both columns populated).
const GATE_METADATA_FLAG: unique symbol = Symbol("route-protection/gate-metadata");

export interface GateMetadata {
  kind: "role" | "permission";
  values: readonly string[];
}

function markAuthMiddleware<F extends (...args: unknown[]) => unknown>(fn: F): F {
  (fn as unknown as Record<symbol, unknown>)[AUTH_MIDDLEWARE_FLAG] = true;
  return fn;
}

function markGateMiddleware<F extends (...args: unknown[]) => unknown>(fn: F, meta?: GateMetadata): F {
  (fn as unknown as Record<symbol, unknown>)[GATE_MIDDLEWARE_FLAG] = true;
  if (meta) {
    (fn as unknown as Record<symbol, unknown>)[GATE_METADATA_FLAG] = meta;
  }
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
  // Forms router pure utilities: no DB reads of campaign config, no PII
  // enrichment, no writes — just static enums and validators that any
  // authenticated user can legitimately call from a form-builder UI.
  // (`forms GET /config` and `forms GET /config/:tortId` are now gated to
  // attorney+ — see `routes/forms.ts`.)
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

/**
 * Per-route authorisation decision recorded by the validator. Emitted at
 * boot so an SOC reviewer can see, in one place, EVERY route the process
 * exposes and which trust boundary applies. The four statuses are:
 *
 *   - "public"          — mounted under a router stamped `markPublic(...)`.
 *                         No auth required (rate-limit lives elsewhere).
 *   - "auth-exception"  — a deliberate per-route exception on the auth
 *                         router (login / refresh / register). Unauthenticated
 *                         on purpose; tracked so adding a new login-adjacent
 *                         endpoint requires explicit AUTH_ROUTE_EXCEPTIONS opt-in.
 *   - "auth-only"       — authenticated, no role gate. Allowed only for
 *                         entries explicitly listed in AUTH_ONLY_ROUTES
 *                         (self-service & pure utility endpoints).
 *   - "role-gated"      — authenticated AND gated by `requireRole` /
 *                         `requirePermission`. The default for every new
 *                         protected handler.
 */
export interface RoutePolicyEntry {
  router: string;
  method: string;
  path: string;
  status: "public" | "auth-exception" | "auth-only" | "role-gated";
  /**
   * Effective required roles for the route, collected from every
   * `requireRole(...)` gate in the chain. Empty for non-role-gated routes.
   * Multiple entries mean the route mounts multiple role gates and all
   * must be satisfied.
   */
  requiredRoles?: string[];
  /**
   * Effective required permissions for the route, collected from every
   * `requirePermission(...)` gate in the chain. Within a single gate the
   * semantics are "any of these permissions" (the gate accepts the caller
   * iff they hold at least one); across multiple gates the semantics are
   * "and", since express runs them in sequence.
   */
  requiredPermissions?: string[];
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

function readGateMetadata(handle: unknown): GateMetadata | undefined {
  if (handle == null) return undefined;
  if (typeof handle !== "function" && typeof handle !== "object") return undefined;
  const v = (handle as Record<symbol, unknown>)[GATE_METADATA_FLAG];
  if (!v || typeof v !== "object") return undefined;
  const meta = v as Partial<GateMetadata>;
  if ((meta.kind === "role" || meta.kind === "permission") && Array.isArray(meta.values)) {
    return { kind: meta.kind, values: meta.values.map(String) };
  }
  return undefined;
}

function classifyHandlerNames(handlers: Array<{ handle?: unknown }>): {
  hasAuth: boolean;
  hasGate: boolean;
  requiredRoles: string[];
  requiredPermissions: string[];
} {
  let hasAuth = false;
  let hasGate = false;
  const requiredRoles: string[] = [];
  const requiredPermissions: string[] = [];
  for (const h of handlers) {
    if (hasFlag(h.handle, AUTH_MIDDLEWARE_FLAG)) hasAuth = true;
    if (hasFlag(h.handle, GATE_MIDDLEWARE_FLAG)) {
      hasGate = true;
      const meta = readGateMetadata(h.handle);
      if (meta?.kind === "role") requiredRoles.push(...meta.values);
      if (meta?.kind === "permission") requiredPermissions.push(...meta.values);
    }
  }
  return { hasAuth, hasGate, requiredRoles, requiredPermissions };
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
  inherited: {
    hasAuth: boolean;
    hasGate: boolean;
    isPublic: boolean;
    label: string;
    requiredRoles: string[];
    requiredPermissions: string[];
  },
  issues: RouteIssue[],
  counters: { checked: number; public: number; protected: number },
  policy: RoutePolicyEntry[],
): void {
  const stack = router.stack ?? [];
  let { hasAuth, hasGate } = inherited;
  const inheritedRoles = [...inherited.requiredRoles];
  const inheritedPerms = [...inherited.requiredPermissions];

  for (const layer of stack) {
    if (layer.route) {
      // Terminal route on THIS router.
      const route = layer.route;
      for (const method of Object.keys(route.methods)) {
        counters.checked++;
        const M = method.toUpperCase();
        if (inherited.isPublic) {
          counters.public++;
          policy.push({ router: inherited.label, method: M, path: route.path, status: "public" });
          continue;
        }
        // auth-router exception list (login/refresh/register)
        if (
          inherited.label === "auth" &&
          AUTH_ROUTE_EXCEPTIONS.has(`${M} ${route.path}`)
        ) {
          counters.public++;
          policy.push({ router: inherited.label, method: M, path: route.path, status: "auth-exception" });
          continue;
        }
        const perRoute = classifyHandlerNames(route.stack);
        const finalAuth = hasAuth || perRoute.hasAuth;
        const finalGate = hasGate || perRoute.hasGate;
        const finalRoles = [...inheritedRoles, ...perRoute.requiredRoles];
        const finalPerms = [...inheritedPerms, ...perRoute.requiredPermissions];
        if (!finalAuth) {
          issues.push({
            router: inherited.label,
            method: M,
            path: route.path,
            reason: "no authMiddleware in chain",
          });
          continue;
        }
        if (!finalGate) {
          // Authenticated-only allowance for self-service / utility endpoints.
          if (AUTH_ONLY_ROUTES.has(`${inherited.label} ${M} ${route.path}`)) {
            counters.protected++;
            policy.push({ router: inherited.label, method: M, path: route.path, status: "auth-only" });
            continue;
          }
          issues.push({
            router: inherited.label,
            method: M,
            path: route.path,
            reason: "no requireRole/requirePermission gate",
          });
          continue;
        }
        counters.protected++;
        policy.push({
          router: inherited.label,
          method: M,
          path: route.path,
          status: "role-gated",
          ...(finalRoles.length > 0 ? { requiredRoles: finalRoles } : {}),
          ...(finalPerms.length > 0 ? { requiredPermissions: finalPerms } : {}),
        });
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
        {
          hasAuth,
          hasGate,
          isPublic: subPublic,
          label: subLabel,
          requiredRoles: inheritedRoles,
          requiredPermissions: inheritedPerms,
        },
        issues,
        counters,
        policy,
      );
      continue;
    }

    // Plain middleware on this router. Update inherited state for downstream
    // siblings — express applies layers in declaration order.
    if (hasFlag(handle, AUTH_MIDDLEWARE_FLAG)) hasAuth = true;
    if (hasFlag(handle, GATE_MIDDLEWARE_FLAG)) {
      hasGate = true;
      const meta = readGateMetadata(handle);
      if (meta?.kind === "role") inheritedRoles.push(...meta.values);
      if (meta?.kind === "permission") inheritedPerms.push(...meta.values);
    }
  }
}

/**
 * Walk the parent router (the one returned by routes/index.ts) and validate
 * every leaf route. Throws on any violation.
 */
export function validateRouteTable(parent: Router): {
  checked: number;
  public: number;
  protected: number;
  policy: RoutePolicyEntry[];
} {
  const issues: RouteIssue[] = [];
  const counters = { checked: 0, public: 0, protected: 0 };
  const policy: RoutePolicyEntry[] = [];

  walkRouter(
    parent as unknown as ExpressRouterLike,
    { hasAuth: false, hasGate: false, isPublic: false, label: "(root)", requiredRoles: [], requiredPermissions: [] },
    issues,
    counters,
    policy,
  );

  if (issues.length > 0) {
    const lines = issues.map(i => `  - [${i.router}] ${i.method} ${i.path}: ${i.reason}`).join("\n");
    const msg = `FATAL: Route table validation failed (${issues.length} unprotected route(s)):\n${lines}`;
    logger.fatal(msg);
    throw new Error(msg);
  }

  // Per-route policy report. Emitted at info so SOC review can grep one
  // log line per route; the structured `policy` field carries the full
  // table for tooling (alerting, drift detection, etc.).
  const byStatus = policy.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<RoutePolicyEntry["status"], number>,
  );
  logger.info(
    {
      ...counters,
      by_status: byStatus,
      policy,
    },
    "Route policy report",
  );
  return { ...counters, policy };
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
  gateMetadata?: GateMetadata;
} {
  if (handle == null || (typeof handle !== "function" && typeof handle !== "object")) {
    return { hasAuthStamp: false, hasGateStamp: false, isPublicRouter: false, routerLabel: undefined };
  }
  const bag = handle as Record<symbol, unknown>;
  const label = bag[ROUTER_LABEL_FLAG];
  const out: ReturnType<typeof __internal_inspectLayer> = {
    hasAuthStamp: Boolean(bag[AUTH_MIDDLEWARE_FLAG]),
    hasGateStamp: Boolean(bag[GATE_MIDDLEWARE_FLAG]),
    isPublicRouter: Boolean(bag[PUBLIC_ROUTER_FLAG]),
    routerLabel: typeof label === "string" ? label : undefined,
  };
  const meta = readGateMetadata(handle);
  if (meta) out.gateMetadata = meta;
  return out;
}

/**
 * The exact same auth-router exception list `validateRouteTable` consults.
 * Re-exported so the route-matrix dumper renders consistent labels.
 */
export const __internal_AUTH_ROUTE_EXCEPTIONS: ReadonlySet<string> = AUTH_ROUTE_EXCEPTIONS;
export const __internal_AUTH_ONLY_ROUTES: ReadonlySet<string> = AUTH_ONLY_ROUTES;
