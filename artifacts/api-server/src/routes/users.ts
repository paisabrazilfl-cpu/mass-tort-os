import { Router } from "express";
import { z } from "zod";
import {
  Permission,
  requirePermission,
  auditAction,
  listUsersByFirm,
  updateUserRoleAndBumpVersion,
  type UserRole,
} from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { badRequest, errorEnvelope, notFound } from "../lib/http-errors";
import { logger } from "../lib/logger";

const router = Router();

const ROLE_VALUES: readonly UserRole[] = [
  "admin", "user_manager", "attorney", "paralegal", "agent", "viewer",
] as const;

const UpdateUserRoleParams = z.object({
  id: z.coerce.number().int().positive(),
});
// super_admin is intentionally NOT assignable through this endpoint — it is
// a singleton owner role set directly in the DB. admin promotion is also
// handled out-of-band so a compromised admin token cannot mint more admins.
// Everything else (user_manager, attorney, paralegal, agent, viewer) is
// assignable by any user holding USERS_MANAGE.
const UpdateUserRoleBody = z.object({
  role: z.enum(["user_manager", "attorney", "paralegal", "agent", "viewer"]),
});

router.get(
  "/",
  requirePermission(Permission.USERS_LIST),
  async (req, res) => {
    const firmId = req.user!.firm_id;
    const rows = await listUsersByFirm(firmId);
    res.json({ status: "ok", data: { rows } });
  },
);

router.patch(
  "/:id/role",
  requirePermission(Permission.USERS_MANAGE),
  auditAction("user_role_change_attempt"),
  async (req, res) => {
    const paramsParsed = UpdateUserRoleParams.safeParse(req.params);
    if (!paramsParsed.success) {
      badRequest(res, "Invalid path parameters", paramsParsed.error.flatten());
      return;
    }
    const bodyParsed = UpdateUserRoleBody.safeParse(req.body);
    if (!bodyParsed.success) {
      badRequest(
        res,
        `role must be one of ${ROLE_VALUES.join(", ")}`,
        bodyParsed.error.flatten(),
      );
      return;
    }

    const targetUserId = paramsParsed.data.id;
    const newRole = bodyParsed.data.role;
    const actor = req.user!;
    const firmId = actor.firm_id;

    // Self-edit guard. The spec forbids self-role-change in either
    // direction so an admin cannot accidentally lock themselves out
    // (admin → viewer) and a viewer cannot escalate themselves
    // (this branch is also defended by requirePermission above, but we
    // re-check here so the audit trail records the attempt with a
    // specific reason).
    if (targetUserId === actor.id) {
      await auditLog(
        "user",
        String(targetUserId),
        "user_role_change_rejected_self",
        {
          actor_user_id: actor.id,
          requested_role: newRole,
          reason: "cannot_change_own_role",
        },
        {
          ip_address:
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress,
          user_agent: req.headers["user-agent"],
        },
      );
      errorEnvelope(
        res,
        403,
        "cannot_change_own_role",
        "You cannot change your own role. Ask another admin to do it.",
      );
      return;
    }

    const updated = await updateUserRoleAndBumpVersion(
      targetUserId,
      firmId,
      newRole,
    );
    if (!updated) {
      // Either the id doesn't exist or it belongs to a different firm.
      // Return the same 404 in both cases so the endpoint is not a
      // cross-firm enumeration oracle.
      notFound(res, "User not found");
      return;
    }

    // Audit shape per task #58 spec: entity=user, action=role_changed,
    // with explicit before/after payload so a future compliance reader
    // can reconstruct exactly what changed without hitting the user
    // table again. `previous_role` comes from the same UPDATE statement
    // (CTE), so the pair is guaranteed atomic w.r.t. the role change.
    await auditLog(
      "user",
      String(updated.id),
      "role_changed",
      {
        actor_user_id: actor.id,
        actor_email: actor.email,
        target_email: updated.email,
        before: { role: updated.previous_role },
        after: { role: updated.role },
        firm_id: firmId,
      },
      {
        ip_address:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
          req.socket.remoteAddress,
        user_agent: req.headers["user-agent"],
      },
    );
    logger.info(
      {
        actor_user_id: actor.id,
        target_user_id: updated.id,
        previous_role: updated.previous_role,
        new_role: updated.role,
        firm_id: firmId,
      },
      "User role changed by admin",
    );

    // Strip the audit-only field from the API response so downstream
    // consumers don't accidentally start to depend on it.
    const { previous_role: _previous, ...response } = updated;
    void _previous;
    res.json({ status: "ok", data: response });
  },
);

export default router;
