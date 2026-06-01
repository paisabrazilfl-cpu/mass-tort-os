// Same-origin static serving for per-tort brand assets referenced by
// form_configurations.site_profile (hero, OG, favicon, logo, content images).
//
// These images are committed under `assets/brand/<tort>/<file>` so they ship
// with the deploy (no object-storage dependency) and are served from our own
// origin — which satisfies the public pages' tight `img-src 'self'` CSP.
//
// The route is intentionally read-only and locked down: only a strict
// `[a-z0-9-]` tort segment and a `<name>.<ext>` filename from a small image
// allowlist are accepted, and the resolved path is asserted to stay inside the
// brand directory (defense-in-depth against path traversal). Public by design.

import express, { type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";

const router = express.Router();

// Resolve the on-disk brand asset root. In dev we run from TS source under
// `src/`; in the built server we run from `dist/`. The committed assets live at
// the package root (`artifacts/api-server/assets/brand`), so walk up from this
// module until we find the `assets/brand` directory.
function brandRoot(): string {
  const candidates = [
    path.resolve(__dirname, "../../assets/brand"),
    path.resolve(__dirname, "../assets/brand"),
    path.resolve(process.cwd(), "assets/brand"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const TORT_RE = /^[a-z0-9-]{1,64}$/;
const FILE_RE = /^[a-z0-9-]{1,64}\.(png|jpg|jpeg|webp|svg|ico)$/;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

router.get("/:tort/:file", (req: Request, res: Response) => {
  const tort = String(req.params.tort ?? "");
  const file = String(req.params.file ?? "");
  if (!TORT_RE.test(tort) || !FILE_RE.test(file)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const root = brandRoot();
  const resolved = path.resolve(root, tort, file);
  // Defense-in-depth: the resolved path must stay within the brand root.
  if (resolved !== path.join(root, tort, file) || !resolved.startsWith(root + path.sep)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  // Brand assets are immutable-ish and safe to cache aggressively.
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(resolved, (err) => {
    if (err) {
      logger.warn({ err, tort, file }, "Failed to send brand asset");
      if (!res.headersSent) res.status(404).type("text/plain").send("Not found");
    }
  });
});

export default markPublic(router, "brand-assets");
