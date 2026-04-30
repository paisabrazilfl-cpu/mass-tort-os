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
import reviewQueueRouter from "./review-queue";
import formsRouter from "./forms";
import formsPublicRouter from "./forms-public";
import webFormsRouter from "./web-forms";
import vendorsRouter from "./vendors";
import securityRouter from "./security";
import timelineRouter from "./timeline";
import draftingRouter from "./drafting";
import authRouter from "./auth";
import integrationsRouter from "./integrations";
import newsRouter from "./news";
import imageObjectsRouter from "./image-objects";
import leadImportRouter from "./lead-import";
import decisionEngineRouter from "./decision-engine";
import leadSourcesRouter from "./lead-sources";
import buyersRouter from "./buyers";
import documentTemplatesRouter from "./document-templates";
import workflowSettingsRouter from "./workflow-settings";
import webhooksRouter from "./webhooks";
import billingRouter from "./billing";
import callsRouter from "./calls";
import vapiToolsRouter from "./vapi-tools";
import usersRouter from "./users";
import { authMiddleware } from "../lib/rbac";
import { firmContextMiddleware } from "../lib/firm-context";
import { markPublic, labelRouter } from "../lib/route-protection";
import { subscriptionGateMiddleware } from "../lib/subscription-gate";

// =============================================================================
// Router registry — keep this list in declaration order so the boot validator
// in `src/lib/route-protection.ts` and the audit report stay in sync. Each
// router is labelled exactly once so error messages from the validator point
// at a recognisable name. Public routers carry `markPublic()` instead so the
// validator skips role-gate checks for them — those routers must do their
// own per-request validation (signature checks, host allowlisting, etc).
// =============================================================================

// PUBLIC: providers cannot send our session cookie / Bearer token.
markPublic(healthRouter, "health");
markPublic(formsPublicRouter, "forms-public");
markPublic(webFormsRouter, "web-forms");
markPublic(webhooksRouter, "webhooks");
// Vapi tool callbacks: PUBLIC because Vapi authenticates with a static
// bearer token (the assistant's tool secret), not a session JWT. Each
// handler verifies the bearer at request time against vault credentials.
markPublic(vapiToolsRouter, "vapi-tools");
// auth router carries a *mix* — login/refresh/register are public, the rest
// are gated. The validator's AUTH_ROUTE_EXCEPTIONS list whitelists the public
// three; everything else must include authMiddleware in its handler chain.
labelRouter(authRouter, "auth");

// PROTECTED routers — labelled for nice validator errors.
labelRouter(leadsRouter, "leads");
labelRouter(documentsRouter, "documents");
labelRouter(dashboardRouter, "dashboard");
labelRouter(casesRouter, "cases");
labelRouter(ocrRouter, "ocr");
labelRouter(paralegalsRouter, "paralegals");
labelRouter(analyticsRouter, "analytics");
labelRouter(complianceRouter, "compliance");
labelRouter(npiRouter, "npi");
labelRouter(reviewQueueRouter, "review-queue");
labelRouter(formsRouter, "forms");
labelRouter(vendorsRouter, "vendors");
labelRouter(securityRouter, "security");
labelRouter(timelineRouter, "timeline");
labelRouter(draftingRouter, "drafting");
labelRouter(integrationsRouter, "integrations");
labelRouter(newsRouter, "news");
labelRouter(imageObjectsRouter, "image-objects");
labelRouter(leadImportRouter, "lead-import");
labelRouter(decisionEngineRouter, "decision-engine");
labelRouter(leadSourcesRouter, "lead-sources");
labelRouter(buyersRouter, "buyers");
labelRouter(documentTemplatesRouter, "document-templates");
labelRouter(workflowSettingsRouter, "workflow-settings");
labelRouter(billingRouter, "billing");
labelRouter(callsRouter, "calls");

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
// Public intake surface lives at /api/forms-public/* — explicitly separated
// from the authenticated /api/forms/* router so the public allowlist contract
// (`/api/healthz`, `/api/forms-public/*`, `/api/webhooks/*`) holds at the
// path-prefix level, not just at the router-label level.
router.use("/forms-public", formsPublicRouter);
// Lightweight public lead-capture forms (the "Web Forms" tab). Distinct
// surface from /api/forms-public/* — these are the simpler embed-on-a-
// landing-page forms with per-tort field/eligibility configuration.
router.use("/web-forms", webFormsRouter);
// Provider webhooks must be PUBLIC (callbacks have no Bearer token).
// Each handler verifies provider signatures internally and always returns 200.
router.use("/webhooks", webhooksRouter);
// Vapi tool callbacks live at /vapi-tools (top-level so the dump-route-
// matrix mount-regex parser, which only captures the first path segment,
// reports the correct mount path). They are public — bearer-gated per
// handler against the active vapi integration row.
router.use("/vapi-tools", vapiToolsRouter);
router.use(authMiddleware);
// Firm context loads req.firm from the firm_id JWT claim stamped by the
// auth middleware. Mounted before the subscription gate so the gate (and
// every downstream handler) can rely on req.firm being populated.
router.use(firmContextMiddleware);
// Subscription gate runs immediately AFTER auth + firm context: blocks
// write methods on protected routes when the firm's Stripe subscription
// is not in good standing. The gate itself is a no-op until a Stripe
// integration is configured (see lib/subscription-gate.ts).
router.use(subscriptionGateMiddleware);
router.use("/billing", billingRouter);
router.use("/calls", callsRouter);
router.use("/leads", leadsRouter);
router.use("/documents", documentsRouter);
router.use("/dashboard", dashboardRouter);
router.use("/cases", casesRouter);
router.use("/ocr", ocrRouter);
router.use("/paralegals", paralegalsRouter);
router.use("/analytics", analyticsRouter);
router.use("/compliance", complianceRouter);
router.use("/npi", npiRouter);
router.use("/review-queue", reviewQueueRouter);
router.use("/forms", formsRouter);
router.use("/vendors", vendorsRouter);
router.use("/security", securityRouter);
router.use("/timeline", timelineRouter);
router.use("/drafting", draftingRouter);
router.use("/integrations", integrationsRouter);
router.use("/news", newsRouter);
router.use("/image-objects", imageObjectsRouter);
router.use("/lead-import", leadImportRouter);
router.use("/decision-engine", decisionEngineRouter);
router.use("/lead-sources", leadSourcesRouter);
router.use("/buyers", buyersRouter);
router.use("/document-templates", documentTemplatesRouter);
router.use("/workflow-settings", workflowSettingsRouter);
router.use("/users", usersRouter);

export default router;
