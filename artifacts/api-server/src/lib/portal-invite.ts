import { db, leadsTable, portalUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createPortalUserForLead, tortTypeToSlug, getPortalBaseUrl, writePortalAudit } from "./portal-auth";
import { getDefaultFirmId } from "./firm-bootstrap";
import { enqueueJob } from "./queue";
import { logger } from "./logger";

// Called fire-and-forget after a background check returns "clean".
// Idempotent: createPortalUserForLead uses onConflictDoUpdate so retries
// are safe. Never throws — all errors are logged and suppressed so the
// caller's request pipeline is never affected.
export async function provisionPortalInvite(leadId: number): Promise<void> {
  try {
    const [lead] = await db
      .select({
        id: leadsTable.id,
        email: leadsTable.email,
        name: leadsTable.name,
        first_name: leadsTable.first_name,
        last_name: leadsTable.last_name,
        tort_type: leadsTable.tort_type,
        firm_id: leadsTable.firm_id,
      })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));

    if (!lead) {
      logger.warn({ leadId }, "provisionPortalInvite: lead not found");
      return;
    }

    // A portal invite requires an email address — without one there is no
    // way to deliver the signup link.
    if (!lead.email) {
      logger.info({ leadId }, "provisionPortalInvite: lead has no email — skipping portal invite");
      return;
    }

    // Resolve firm_id: prefer the lead's own firm_id, fall back to the
    // single-firm shell default for public web-form submissions that
    // haven't been assigned to a firm yet.
    let firmId = lead.firm_id ?? null;
    if (!firmId) {
      firmId = await getDefaultFirmId();
    }
    if (!firmId) {
      logger.warn({ leadId }, "provisionPortalInvite: could not resolve firm_id — skipping");
      return;
    }

    const fullName =
      lead.name ||
      [lead.first_name, lead.last_name].filter(Boolean).join(" ") ||
      lead.email;

    const { signupToken } = await createPortalUserForLead({
      lead_id: lead.id,
      firm_id: firmId,
      email: lead.email,
      name: fullName,
    });

    const slug = tortTypeToSlug(lead.tort_type);
    const base = getPortalBaseUrl();
    const signupLink = `${base}/${slug}/signup?token=${signupToken}`;
    const tortLabel = lead.tort_type;

    const subject = `Your ${tortLabel} case portal is ready`;
    const html = `
      <p>Hi ${fullName},</p>
      <p>Good news — your background screening has cleared and your case portal is ready.</p>
      <p>Click the button below to set up your account and access your case documents, medical record status, and case updates:</p>
      <p>
        <a href="${signupLink}"
           style="background:#1a56db;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;">
          Set Up My Portal Account
        </a>
      </p>
      <p style="color:#6b7280;font-size:13px;">This link expires in 24 hours. If you did not submit a claim, you can safely ignore this email.</p>
    `;
    const text = [
      `Hi ${fullName},`,
      "",
      `Your ${tortLabel} case portal is ready. Set up your account here:`,
      signupLink,
      "",
      "This link expires in 24 hours.",
    ].join("\n");

    await enqueueJob("send_workflow_email", {
      lead_id: lead.id,
      to: lead.email,
      to_name: fullName,
      subject,
      html,
      text,
    });

    await writePortalAudit({
      lead_id: lead.id,
      firm_id: firmId,
      action: "portal.invite_sent",
      metadata: { tort_type: lead.tort_type },
    });

    logger.info({ leadId, email: lead.email }, "Portal invite enqueued");
  } catch (err) {
    logger.warn({ err, leadId }, "provisionPortalInvite failed (non-blocking)");
  }
}
