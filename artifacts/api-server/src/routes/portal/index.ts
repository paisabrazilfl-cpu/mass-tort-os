import { Router } from "express";
import authRouter from "./auth";
import caseRouter from "./case";
import documentsRouter from "./documents";
import recordsRouter from "./records";

// Portal router — mounted at /portal in routes/index.ts.
// Marked public at the CRM level (the portal manages its own JWT layer via
// portalAuthMiddleware, not the CRM's authMiddleware). Each sub-router applies
// portalAuthMiddleware individually on routes that require authentication.
const router = Router();

// Auth: signup, login, logout, refresh, email-verify, MFA setup/verify, /me
router.use("/auth", authRouter);

// Authenticated portal surfaces (all require portalAuthMiddleware + requirePortalMfa)
router.use("/case", caseRouter);
router.use("/documents", documentsRouter);
router.use("/records", recordsRouter);

// Future sub-routers (added per plan step):
// Step 8:  router.use("/admin",  adminRouter);
// Step 9:  router.use("/fasten", fastenRouter);

export default router;
