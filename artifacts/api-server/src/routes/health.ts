import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
export const BUILD_VERSION = "v20260511-ci";

function healthHandler(_req: import("express").Request, res: import("express").Response): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, version: BUILD_VERSION, ts: Date.now() });
}

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

// CI status endpoint — returns latest CI poller state
router.get("/admin/ci-status", (_req, res) => {
  try {
    // Dynamic import to avoid circular dep at module load
    const { getCiState } = require("../lib/ci-poller");
    res.json({ ok: true, ci: getCiState() });
  } catch {
    res.json({ ok: true, ci: { state: "NOT_STARTED" } });
  }
});

export default router;
