import { Router, type Request, type Response, type IRouter } from "express";

const router: IRouter = Router();
const BUILD_VERSION = "v20260511-fixes";

function healthHandler(_req: Request, res: Response): void {
  res.json({ status: "ok", version: BUILD_VERSION });
}

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

export default router;
