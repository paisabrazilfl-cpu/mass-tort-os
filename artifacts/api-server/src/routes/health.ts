import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const BUILD_VERSION = "v3-20260511-autofix";

function healthHandler(_req: import("express").Request, res: import("express").Response): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, version: BUILD_VERSION, ts: Date.now() });
}

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

export default router;
