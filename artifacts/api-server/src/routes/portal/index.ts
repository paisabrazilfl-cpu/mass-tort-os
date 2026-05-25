import { Router } from "express";
import authRouter from "./auth";

// Portal router — mounted at /portal in routes/index.ts.
// Marked public at the CRM level (the portal manages its own JWT layer via
// portalAuthMiddleware, not the CRM's authMiddleware). Each sub-router applies
// portalAuthMiddleware individually on routes that require authentication.
const router = Router();

// Auth: signup, login, logout, refresh, email-verify, MFA setup/verify, /me
router.use("/auth", authRouter);

// Future sub-routers (added per plan step):
// Step 5:  router.use("/case",      caseRouter);
// Step 5:  router.use("/documents", documentsRouter);
// Step 5:  router.use("/records",   recordsRouter);
// Step 8:  router.use("/admin",     adminRouter);
// Step 9:  router.use("/fasten",    fastenRouter);

export default router;
