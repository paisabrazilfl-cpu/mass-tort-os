/**
 * Dump the live express route table to a markdown matrix.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/dump-route-matrix.ts > /tmp/routes-table.md
 *
 * Used to keep `docs/audits/rbac-remediation-2026-04-26.md` honest — the
 * audit report includes the matrix this script produces, regenerated against
 * the actual express tree (not a hand-edited list that can drift).
 *
 * IMPORTANT: This walker is a strict mirror of `validateRouteTable` in
 * `src/lib/route-protection.ts`. To guarantee that the matrix and the boot
 * validator can never disagree, ALL trust-boundary checks (auth stamp, gate
 * stamp, public-router flag, router label, auth-router exceptions, auth-only
 * allow-list) are imported from `route-protection.ts` via the
 * `__internal_*` surface. Do NOT add a parallel local copy of any of these
 * sets or symbol-detection helpers — that drift is exactly what the previous
 * iteration of this file got dinged for in code review.
 */
import routesIndex from "../routes/index";
import {
  __internal_inspectLayer,
  __internal_AUTH_ROUTE_EXCEPTIONS,
  __internal_AUTH_ONLY_ROUTES,
} from "../lib/route-protection";

interface Row {
  router: string;
  method: string;
  path: string;
  hasAuth: boolean;
  hasGate: boolean;
  isPublic: boolean;
  authOnly: boolean;
  authException: boolean;
}

function mountPathFromRegexp(regexp: RegExp | undefined): string {
  if (!regexp) return "";
  // Express compiles `/leads` into `^\/leads\/?(?=\/|$)` — extract the first
  // path segment. Sub-router mounts are always single-segment in this
  // codebase (see routes/index.ts), so a one-segment match is sufficient.
  const m = regexp.source.match(/^\^\\?\/?(?<seg>[^\\?(]+)/);
  if (!m?.groups?.seg) return "";
  return "/" + m.groups.seg.replace(/\\/g, "");
}

const rows: Row[] = [];

function walk(
  router: { stack?: unknown[] } | undefined,
  mountPath: string,
  label: string,
  hasAuth: boolean,
  hasGate: boolean,
  isPublic: boolean,
): void {
  if (!router?.stack) return;
  for (const layer of router.stack as Array<Record<string, unknown>>) {
    const route = layer["route"] as
      | { path: string; methods: Record<string, boolean>; stack: Array<{ handle?: unknown }> }
      | undefined;
    if (route) {
      const methods = Object.keys(route.methods).filter((m) => route.methods[m]).map((m) => m.toUpperCase());
      for (const method of methods) {
        let h = hasAuth;
        let g = hasGate;
        for (const sub of route.stack) {
          const stamps = __internal_inspectLayer(sub.handle);
          if (stamps.hasAuthStamp) h = true;
          if (stamps.hasGateStamp) g = true;
        }
        const fullPath = (mountPath + route.path).replace(/\/+/g, "/");
        rows.push({
          router: label,
          method,
          path: fullPath,
          hasAuth: h,
          hasGate: g,
          isPublic,
          authException:
            label === "auth" && __internal_AUTH_ROUTE_EXCEPTIONS.has(`${method} ${route.path}`),
          authOnly: __internal_AUTH_ONLY_ROUTES.has(`${label} ${method} ${route.path}`),
        });
      }
      continue;
    }

    const handle = layer["handle"];
    if (
      handle &&
      (typeof handle === "function" || typeof handle === "object") &&
      (handle as { stack?: unknown[] }).stack
    ) {
      const stamps = __internal_inspectLayer(handle);
      const childLabel = stamps.routerLabel ?? label;
      // Public propagates only via the symbol stamp on this exact router —
      // no parallel allow-list. Inheritance from a parent (markPublic on a
      // grandparent) still flows through the recursive `isPublic` argument.
      const childPublic = isPublic || stamps.isPublicRouter;
      walk(
        handle as { stack?: unknown[] },
        mountPath + mountPathFromRegexp(layer["regexp"] as RegExp | undefined),
        childLabel,
        hasAuth,
        hasGate,
        childPublic,
      );
      continue;
    }

    const stamps = __internal_inspectLayer(handle);
    if (stamps.hasAuthStamp) hasAuth = true;
    if (stamps.hasGateStamp) hasGate = true;
  }
}

// `routesIndex` is the parent express Router that gets mounted at /api in
// src/index.ts. Walk it directly so we don't have to deal with express's
// outer "(root)" layer wrapper that varies between express 4 and 5.
walk(routesIndex as unknown as { stack?: unknown[] }, "/api", "(root)", false, false, false);

rows.sort((a, b) => (a.router + a.path + a.method).localeCompare(b.router + b.path + b.method));

console.log("| Router | Method | Path | Auth | Gate | Public | Auth-only | Login-exception |");
console.log("|---|---|---|:-:|:-:|:-:|:-:|:-:|");
for (const r of rows) {
  // The express mount-regexp parser above only captures the OUTER /api
  // segment reliably — splice in the router label so the path column reads
  // as "/api/<router>/<route>" which matches what an HTTP client sees.
  const displayPath =
    r.router === "(root)" ? r.path : r.path.replace(/^\/api/, `/api/${r.router}`).replace(/\/+/g, "/");
  console.log(
    `| ${r.router} | ${r.method} | \`${displayPath}\` | ${r.hasAuth ? "✓" : ""} | ${r.hasGate ? "✓" : ""} | ${
      r.isPublic ? "✓" : ""
    } | ${r.authOnly ? "✓" : ""} | ${r.authException ? "✓" : ""} |`,
  );
}
console.error(`Total rows: ${rows.length}`);
process.exit(0);
