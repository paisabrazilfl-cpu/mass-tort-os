import type { IRouter, Router } from "express";
import { logger } from "./logger";

/**
 * Boot-time route table validator. Refuses to start the process if any
 * non-public handler is missing a `requireRole` / `requirePermission` gate.
 *
 * The walker descends each router tracking two bits inherited from parent
 * routers:
 *   - hasAuth: an `authMiddleware` layer is mounted in the chain
 *   - hasGate: a `requireRole` / `requirePermission` layer is mounted
 *
 * For each terminal route, asserts `(hasAuth && hasGate)` unless the
 * router is tagged `markPublic(...)` or the route is in the per-router
 * `AUTH_ROUTE_EXCEPTIONS` / `AUTH_ONLY_ROUTES` allowlists below.
 */

// Module-LOCAL symbols (NOT registered via Symbol.for) — only this module
// can mark or read them. That keeps the trust boundary inside this file:
// a contributor cannot import a helper from elsewhere and forge a passing
// validation by stamping their own router/middleware.
const PUBLIC_ROUTER_FLAG: unique symbol = Symbol("route-protection/public");
const ROUTER_LABEL_FLAG: unique symbol = Symbol("route-protection/label");
const AUTH_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/auth");
const GATE_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/gate");
// Carries the EFFECTIVE { kind: "role"|"permission", values: string[] }
// for a gate middleware so the boot-time policy report can render it.
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

// Symbol-based detection only — no Function.name fallback (a contributor
// could otherwise defeat the validator by naming a noop "requireRole").

/**
 * Auth-router routes that are deliberately unauthenticated. Matched
 * `${METHOD} ${path}` exactly so new login-adjacent endpoints aren't
 * accidentally exempt.
 */
const AUTH_ROUTE_EXCEPTIONS = new Set([
  "POST /login",
  "POST /refresh",
  "POST /register",
]);

/**
 * Authenticated routes that legitimately do not need a role gate (caller's
 * own account or pure stateless utility). Keys are
 * `${routerLabel} ${METHOD} ${path}`; an SOC review can grep this set to
 * enumerate every "auth-only" exception.
 */
const AUTH_ONLY_ROUTES = new Set([
  // auth router — self-service on caller's own account.
  "auth POST /logout",
  "auth POST /change-password",
  "auth POST /mfa/setup",
  "auth POST /mfa/verify",
  "auth POST /mfa/disable",
  "auth GET /me",
  // forms router — pure stateless utilities. config GETs are role-gated.
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
 * Per-route authorisation decision emitted at boot. Statuses:
 *   - "public"          — router tagged `markPublic(...)`. No auth.
 *   - "auth-exception"  — auth-router exception (login/refresh/register).
 *   - "auth-only"       — authenticated; explicitly allowlisted in
 *                         AUTH_ONLY_ROUTES (self-service / pure utility).
 *   - "role-gated"      — authenticated AND gated by requireRole /
 *                         requirePermission. Default for every protected
 *                         handler.
 */
export interface RoutePolicyEntry {
  router: string;
  method: string;
  path: string;
  status: "public" | "auth-exception" | "auth-only" | "role-gated";
  /** Required roles collected from every `requireRole` gate in the chain. */
  requiredRoles?: string[];
  /** Required permissions collected from every `requirePermission` gate in
   *  the chain. Within one gate: any-of. Across gates: and. */
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
 * Walk a router's `stack` in declaration order, accumulating
 * auth/gate/role/perm state. Sub-routers recurse with inherited state;
 * terminal routes combine inherited state with their per-handler stack.
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

    // Non-route layer: middleware OR mounted sub-router. Express routers are
    // callable (typeof "function") with a `.stack` array; plain middleware
    // never carries `.stack`.
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

  // Structured policy report at info level — one log line, full table.
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
 * Inspect a single express handle (middleware or sub-router) and report
 * which trust-boundary stamps it carries. Consumed by
 * `scripts/dump-route-matrix.ts` so the audit-doc matrix is computed
 * against the same symbol identities `validateRouteTable` checks (no
 * string-name drift).
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
