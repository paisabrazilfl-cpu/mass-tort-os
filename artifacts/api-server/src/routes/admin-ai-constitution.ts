// GET /api/admin/ai-constitution
//
// Serves the canonical AI Constitution that governs every helper LLM
// inside this CRM. Any in-process or out-of-process AI helper should
// be able to fetch this and prepend it (or its sha-pinned cached
// version) to its prompt.
//
// RBAC: gated behind AUTOMATIONS_VIEW — broader than API_KEYS_MANAGE
// because workflow operators (paralegals, attorneys) legitimately need
// to read the rules the assistant obeys. The document does not contain
// secrets; it describes architecture and policy.
//
// Response shape (also returned with `?format=markdown` as text/plain
// for easy inspection in the browser):
//   {
//     version: number,
//     sha256: string,
//     bytes: number,
//     retrieved_at: ISO8601,
//     markdown: string,
//   }

import { Router } from "express";
import { Permission, requirePermission } from "../lib/rbac";
import { getAiConstitution } from "../lib/ai-constitution";

const router = Router();

router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), (req, res) => {
  const payload = getAiConstitution();
  if (req.query.format === "markdown") {
    res.type("text/markdown; charset=utf-8").send(payload.markdown);
    return;
  }
  res.json(payload);
});

export default router;
