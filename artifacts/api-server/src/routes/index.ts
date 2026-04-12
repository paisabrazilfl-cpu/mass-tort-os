import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leadsRouter from "./leads";
import documentsRouter from "./documents";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/leads", leadsRouter);
router.use("/documents", documentsRouter);
router.use("/dashboard", dashboardRouter);

export default router;
