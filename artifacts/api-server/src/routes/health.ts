import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
export const BUILD_VERSION = "v20260511-security";

// Shared CI state store — CI poller writes here, endpoint reads
export let _ciState: Record<string, unknown> = { state: "NOT_STARTED" };

function healthHandler(_req: import("express").Request, res: import("express").Response): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, version: BUILD_VERSION, ts: Date.now() });
}

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

// Public CI status endpoint
router.get("/admin/ci-status", (_req, res) => {
  res.json({ ok: true, ci: _ciState });
});

export default router;
