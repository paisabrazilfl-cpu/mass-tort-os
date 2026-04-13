import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leadsRouter from "./leads";
import documentsRouter from "./documents";
import dashboardRouter from "./dashboard";
import casesRouter from "./cases";
import ocrRouter from "./ocr";
import paralegalsRouter from "./paralegals";
import analyticsRouter from "./analytics";
import complianceRouter from "./compliance";
import npiRouter from "./npi";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/leads", leadsRouter);
router.use("/documents", documentsRouter);
router.use("/dashboard", dashboardRouter);
router.use("/cases", casesRouter);
router.use("/ocr", ocrRouter);
router.use("/paralegals", paralegalsRouter);
router.use("/analytics", analyticsRouter);
router.use("/compliance", complianceRouter);
router.use("/npi", npiRouter);

export default router;
