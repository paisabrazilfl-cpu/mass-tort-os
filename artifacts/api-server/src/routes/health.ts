import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// SENTINEL_V2
function healthHandler(_req: import("express").Request, res: import("express").Response): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

export default router;
