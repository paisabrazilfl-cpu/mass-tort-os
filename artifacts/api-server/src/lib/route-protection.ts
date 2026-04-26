import type { IRouter, Router } from "express";
import { logger } from "./logger";

// Boot-time route validator: refuses to start if any non-public handler is
// missing a requireRole/requirePermission gate. For each terminal route,
// asserts (hasAuth && hasGate) unless the router is markPublic(...) or the
// route is in AUTH_ROUTE_EXCEPTIONS or AUTH_ONLY_ROUTES.

// Module-local (not Symbol.for) so only this file can stamp/read.
const PUBLIC_ROUTER_FLAG: unique symbol = Symbol("route-protection/public");
const ROUTER_LABEL_FLAG: unique symbol = Symbol("route-protection/label");
const AUTH_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/auth");
const GATE_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/gate");
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

// Re-exported with __internal_ names so only lib/rbac.ts imports them.
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

// Express routers are callable (typeof === "function") with mounted props,
// so accept both "function" and "object".
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

// Auth-router routes that are deliberately unauthenticated. Exact
// `${METHOD} ${path}` match.
const AUTH_ROUTE_EXCEPTIONS = new Set([
  "POST /login",
  "POST /refresh",
  "POST /register",
]);

// Authenticated routes that legitimately do not need a role gate (caller's
// own account or pure stateless utility). Keys: `${routerLabel} ${METHOD} ${path}`.
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

// Per-route authorisation decision emitted at boot. Statuses:
//   public         — router tagged markPublic(...)
//   auth-exception — auth-router exception (login/refresh/register)
//   auth-only      — authenticated; allowlisted in AUTH_ONLY_ROUTES
//   role-gated     — authenticated AND requireRole/requirePermission gated
export interface RoutePolicyEntry {
  router: string;
  method: string;
  path: string;
  status: "public" | "auth-exception" | "auth-only" | "role-gated";
  requiredRoles?: string[];
  // Within one gate: any-of. Across gates: and.
  requiredPermissions?: string[];
}

// Express layer shape — fields differ between v4 and v5.
//   v5: layer.slash (boolean), layer.match(path) → boolean
//   v4: layer.regexp.fast_slash, layer.regexp.test(path)
interface ExpressLayer {
  name?: string;
  slash?: boolean;
  regexp?: RegExp & { fast_slash?: boolean };
  match?: (path: string) => boolean;
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

// Path-scoped middleware contribution applied only to sibling routes whose
// path the layer's matcher accepts.
interface ScopedContribution {
  matches: (path: string) => boolean;
  hasAuth: boolean;
  hasGate: boolean;
  requiredRoles: string[];
  requiredPermissions: string[];
}

// True for `router.use(handler)` (no path argument). When neither v4 nor v5
// shape is present, conservatively return false (treat as scoped).
function isUnscopedLayer(layer: ExpressLayer): boolean {
  if (typeof layer.slash === "boolean") return layer.slash;
  const re = layer.regexp;
  if (!re) return false;
  if (re.fast_slash === true) return true;
  return re.source === "^\\/?(?=\\/|$)";
}

function pathMatcherFor(layer: ExpressLayer): ((path: string) => boolean) | undefined {
  if (typeof layer.match === "function") {
    const fn = layer.match.bind(layer);
    return (p) => Boolean(fn(p));
  }
  const re = layer.regexp;
  if (re) return (p) => re.test(p);
  return undefined;
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

// Walk router.stack in declaration order. Unscoped middleware is promoted to
// inherited state for every subsequent sibling and sub-router. Path-scoped
// middleware applies only to siblings whose path matches; sub-routers do
// NOT inherit scoped contributions (conservative).
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
  const scopedLocal: ScopedContribution[] = [];

  function applyScoped(routePath: string): {
    hasAuth: boolean;
    hasGate: boolean;
    roles: string[];
    perms: string[];
  } {
    let a = false;
    let g = false;
    const roles: string[] = [];
    const perms: string[] = [];
    for (const s of scopedLocal) {
      if (s.matches(routePath)) {
        if (s.hasAuth) a = true;
        if (s.hasGate) g = true;
        roles.push(...s.requiredRoles);
        perms.push(...s.requiredPermissions);
      }
    }
    return { hasAuth: a, hasGate: g, roles, perms };
  }

  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const sc = applyScoped(route.path);
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
        const finalAuth = hasAuth || sc.hasAuth || perRoute.hasAuth;
        const finalGate = hasGate || sc.hasGate || perRoute.hasGate;
        const finalRoles = [...inheritedRoles, ...sc.roles, ...perRoute.requiredRoles];
        const finalPerms = [...inheritedPerms, ...sc.perms, ...perRoute.requiredPermissions];
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

    // Non-route layer: middleware OR mounted sub-router. Routers are callable
    // with a `.stack` array; plain middleware has no `.stack`.
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

    const layerHasAuth = hasFlag(handle, AUTH_MIDDLEWARE_FLAG);
    const layerHasGate = hasFlag(handle, GATE_MIDDLEWARE_FLAG);
    if (!layerHasAuth && !layerHasGate) continue;
    const meta = layerHasGate ? readGateMetadata(handle) : undefined;
    const layerRoles = meta?.kind === "role" ? meta.values.map(String) : [];
    const layerPerms = meta?.kind === "permission" ? meta.values.map(String) : [];

    if (isUnscopedLayer(layer)) {
      if (layerHasAuth) hasAuth = true;
      if (layerHasGate) {
        hasGate = true;
        inheritedRoles.push(...layerRoles);
        inheritedPerms.push(...layerPerms);
      }
      continue;
    }

    const matches = pathMatcherFor(layer);
    if (!matches) continue;
    scopedLocal.push({
      matches,
      hasAuth: layerHasAuth,
      hasGate: layerHasGate,
      requiredRoles: layerRoles,
      requiredPermissions: layerPerms,
    });
  }
}

// Validates every leaf route under `parent`. Throws on any violation.
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

// Reports which trust-boundary stamps a handle carries. Consumed by
// scripts/dump-route-matrix.ts so the audit-doc matrix uses the same symbol
// identities the validator checks.
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
