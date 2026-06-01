// Sites AI Chat router.
//
// Backs the persistent "Sites AI Assistant" — a conversational AI scoped to the
// Sites/SEO-network domain. Chat access is open to anyone who can see the Sites
// tab (FORMS_CONFIG_VIEW). The assistant can PROPOSE privileged actions
// (rebuild-all, SEO rebuild-all, create/edit a site); nothing executes until the
// operator confirms in chat AND passes the per-action re-authorization enforced
// by lib/sites-ai/actions.ts (rebuild → super_admin; create/edit → manage).
//
//   GET    /api/sites-ai/conversations                          — list (firm-scoped)
//   POST   /api/sites-ai/conversations                          — create
//   GET    /api/sites-ai/conversations/:id                      — one + messages
//   DELETE /api/sites-ai/conversations/:id                      — delete
//   POST   /api/sites-ai/conversations/:id/messages            — send + assistant reply
//   POST   /api/sites-ai/conversations/:id/messages/:mid/confirm — execute proposal
//   POST   /api/sites-ai/conversations/:id/messages/:mid/cancel  — decline proposal
//   POST   /api/sites-ai/uploads/request-url                    — presigned upload URL
//   GET    /api/sites-ai/conversations/:id/messages/:mid/attachments/:idx — serve file

import { Router, type Request, type Response } from "express";
import { Readable } from "stream";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";

import { db, conversations, messages } from "@workspace/db";
import type { MessageAttachment } from "@workspace/db";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { getAllFormConfigs } from "../lib/form-config-service";
import {
  runSitesAssistant,
  type SiteRegistryEntry,
  type ChatHistoryEntry,
} from "../lib/sites-ai/assistant";
import { executeProposal, summarizeExecResult } from "../lib/sites-ai/actions";
import {
  buildAttachmentContext,
  checkAttachmentsPolicy,
  checkUploadPolicy,
  verifyStoredAttachments,
} from "../lib/sites-ai/attachments";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router = Router();
router.use(authMiddleware);

const objectStorageService = new ObjectStorageService();
const SITES_SCOPE = "sites";

// Uploads are bound to the caller's firm by nesting the object key under a
// per-firm prefix. The presigned upload URL only writes here, and both
// message-create and the serve endpoint reject any attachment path that is not
// under the caller's own firm prefix — so a chat user cannot attach or read an
// object belonging to another firm by forging its path.
function firmUploadPrefix(firmId: number): string {
  return `uploads/sites-ai/firm-${firmId}`;
}
function firmObjectPathPrefix(firmId: number): string {
  return `/objects/${firmUploadPrefix(firmId)}/`;
}

const attachmentSchema = z.object({
  name: z.string().min(1).max(300),
  objectPath: z.string().min(1).max(600),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(200),
});

const createConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  attachments: z.array(attachmentSchema).max(10).optional(),
});

const uploadUrlSchema = z.object({
  name: z.string().min(1).max(300),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(200),
});

function auditMeta(req: Request) {
  return {
    ip_address: req.ip,
    user_agent: req.get("user-agent") ?? undefined,
  };
}

// Resolve the conversation iff it belongs to the caller's firm AND is a Sites
// conversation. Returns null otherwise — strict firm tenancy at the DB layer.
async function getOwnedConversation(firmId: number, id: number) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.firmId, firmId),
        eq(conversations.scope, SITES_SCOPE),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── GET /conversations — list firm-scoped Sites conversations ─────────────────
router.get(
  "/conversations",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    try {
      const user = req.user!;
      const rows = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .where(and(eq(conversations.firmId, user.firm_id), eq(conversations.scope, SITES_SCOPE)))
        .orderBy(desc(conversations.updatedAt));
      res.json({ conversations: rows });
    } catch (err) {
      logger.error({ err }, "sites-ai list conversations failed");
      serverError(res, "Failed to list conversations");
    }
  },
);

// ── POST /conversations — create ──────────────────────────────────────────────
router.post(
  "/conversations",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid request", parsed.error.flatten());
    try {
      const user = req.user!;
      const [row] = await db
        .insert(conversations)
        .values({
          title: parsed.data.title?.trim() || "New Sites chat",
          firmId: user.firm_id,
          userId: user.id,
          scope: SITES_SCOPE,
        })
        .returning();
      res.status(201).json({ conversation: row });
    } catch (err) {
      logger.error({ err }, "sites-ai create conversation failed");
      serverError(res, "Failed to create conversation");
    }
  },
);

// ── GET /conversations/:id — one conversation with its messages ───────────────
router.get(
  "/conversations/:id",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, "Invalid conversation id");
    try {
      const user = req.user!;
      const convo = await getOwnedConversation(user.firm_id, id);
      if (!convo) return notFound(res, "Conversation not found");
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.id));
      res.json({ conversation: convo, messages: msgs });
    } catch (err) {
      logger.error({ err }, "sites-ai get conversation failed");
      serverError(res, "Failed to load conversation");
    }
  },
);

// ── DELETE /conversations/:id ─────────────────────────────────────────────────
router.delete(
  "/conversations/:id",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, "Invalid conversation id");
    try {
      const user = req.user!;
      const convo = await getOwnedConversation(user.firm_id, id);
      if (!convo) return notFound(res, "Conversation not found");
      await db.delete(conversations).where(eq(conversations.id, id));
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "sites-ai delete conversation failed");
      serverError(res, "Failed to delete conversation");
    }
  },
);

// ── POST /conversations/:id/messages — send a message + get assistant reply ───
router.post(
  "/conversations/:id/messages",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, "Invalid conversation id");
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid request", parsed.error.flatten());
    try {
      const user = req.user!;
      const convo = await getOwnedConversation(user.firm_id, id);
      if (!convo) return notFound(res, "Conversation not found");

      const attachments = parsed.data.attachments ?? [];
      // Bind every attachment to THIS firm's upload prefix. Reject any path the
      // client may have forged to point at another firm's private object.
      const allowedPrefix = firmObjectPathPrefix(user.firm_id);
      if (attachments.some((a) => !a.objectPath.startsWith(allowedPrefix))) {
        return badRequest(res, "Invalid attachment path");
      }
      // Re-enforce the upload policy (MIME allowlist + size cap) at attach time
      // so the signed-URL check can't be bypassed by posting a raw objectPath.
      const attachPolicy = checkAttachmentsPolicy(attachments);
      if (!attachPolicy.ok) return badRequest(res, attachPolicy.message);
      // Hard-enforce against the STORED object metadata (real size + type), not
      // the client-declared values, closing the falsified-metadata bypass.
      const storedPolicy = await verifyStoredAttachments(attachments);
      if (!storedPolicy.ok) return badRequest(res, storedPolicy.message);
      const [userMsg] = await db
        .insert(messages)
        .values({
          conversationId: id,
          role: "user",
          content: parsed.data.content,
          attachments,
        })
        .returning();

      // Build history (prior messages) + a live registry snapshot for grounding.
      const prior = await db
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.id));
      const history: ChatHistoryEntry[] = prior
        .filter((m) => m.id !== userMsg.id)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        }));

      const configs = await getAllFormConfigs();
      const registry: SiteRegistryEntry[] = configs.map((c) => ({
        slug: c.id,
        label: c.label,
        category: c.category,
        active: c.active,
        enabled: Boolean(c.web_form_config?.enabled),
      }));

      // Extract bounded text from the uploaded attachments so the assistant
      // can actually reason over their content (honest: binary/unsupported
      // formats are noted, not faked).
      const attachmentContext = await buildAttachmentContext(attachments);

      const result = await runSitesAssistant({
        userMessage: parsed.data.content,
        history,
        registry,
        attachmentContext,
      });

      if (!result.ok) {
        const [assistantMsg] = await db
          .insert(messages)
          .values({
            conversationId: id,
            role: "assistant",
            content:
              "I couldn't process that request right now. Please try rephrasing, or try again in a moment.",
          })
          .returning();
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, id));
        logger.warn({ code: result.code, attempts: result.attempts }, "sites-ai assistant failed");
        res.status(200).json({
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          error: { code: result.code, message: result.message },
        });
        return;
      }

      const proposal = result.turn.proposal;
      const [assistantMsg] = await db
        .insert(messages)
        .values({
          conversationId: id,
          role: "assistant",
          content: result.turn.reply,
          proposal: proposal ?? null,
          proposalStatus: proposal ? "pending" : null,
        })
        .returning();

      await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));

      res.status(201).json({ userMessage: userMsg, assistantMessage: assistantMsg });
    } catch (err) {
      logger.error({ err }, "sites-ai send message failed");
      serverError(res, "Failed to send message");
    }
  },
);

// Resolve a pending-proposal message inside an owned conversation.
async function getOwnedProposalMessage(firmId: number, convoId: number, messageId: number) {
  const convo = await getOwnedConversation(firmId, convoId);
  if (!convo) return { convo: null, message: null } as const;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, convoId)))
    .limit(1);
  return { convo, message: message ?? null } as const;
}

// ── POST /conversations/:id/messages/:mid/confirm — execute proposal ──────────
router.post(
  "/conversations/:id/messages/:messageId/confirm",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const id = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(id) || !Number.isInteger(messageId)) {
      return badRequest(res, "Invalid id");
    }
    try {
      const user = req.user!;
      const { convo, message } = await getOwnedProposalMessage(user.firm_id, id, messageId);
      if (!convo || !message) return notFound(res, "Message not found");
      if (!message.proposal) return badRequest(res, "This message has no proposed action");
      if (message.proposalStatus !== "pending") {
        return badRequest(res, `Action already ${message.proposalStatus}`);
      }

      // ATOMIC claim: only the request that flips pending→confirmed proceeds.
      // Two concurrent confirms can't both pass — the WHERE guard means only one
      // UPDATE returns a row, so a privileged action runs exactly once.
      const claimed = await db
        .update(messages)
        .set({ proposalStatus: "confirmed" })
        .where(and(eq(messages.id, messageId), eq(messages.proposalStatus, "pending")))
        .returning({ id: messages.id });
      if (claimed.length === 0) {
        return badRequest(res, "Action already in progress or completed");
      }

      // From here the message is "confirmed"; guarantee it reaches a terminal
      // state (executed/failed) even if executeProposal throws.
      const proposal = message.proposal;
      try {
        // PER-ACTION re-authorization happens inside executeProposal.
        const exec = await executeProposal(user, proposal, auditMeta(req));

        if (!exec.ok) {
          await db
            .update(messages)
            .set({ proposalStatus: "failed", proposalResult: { error: exec.message } })
            .where(eq(messages.id, messageId));
          const [followUp] = await db
            .insert(messages)
            .values({
              conversationId: id,
              role: "assistant",
              content: `That action could not be completed: ${exec.message}`,
            })
            .returning();
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, id));
          const status = exec.code === "forbidden" ? 403 : exec.code === "not_found" ? 404 : 400;
          res.status(status).json({ ok: false, error: exec, followUp });
          return;
        }

        await db
          .update(messages)
          .set({ proposalStatus: "executed", proposalResult: exec.result })
          .where(eq(messages.id, messageId));
        const [followUp] = await db
          .insert(messages)
          .values({
            conversationId: id,
            role: "assistant",
            content: summarizeExecResult(proposal.kind, exec.result),
            proposalResult: exec.result,
          })
          .returning();
        await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));

        res.json({ ok: true, result: exec.result, followUp });
      } catch (execErr) {
        // Never leave the proposal stuck in "confirmed": record the failure so
        // the operator sees it and the lifecycle is terminal.
        logger.error({ err: execErr }, "sites-ai proposal execution threw");
        await db
          .update(messages)
          .set({ proposalStatus: "failed", proposalResult: { error: "Execution error" } })
          .where(eq(messages.id, messageId));
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, id));
        serverError(res, "Failed to execute action");
      }
    } catch (err) {
      logger.error({ err }, "sites-ai confirm proposal failed");
      serverError(res, "Failed to execute action");
    }
  },
);

// ── POST /conversations/:id/messages/:mid/cancel — decline a proposal ─────────
router.post(
  "/conversations/:id/messages/:messageId/cancel",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const id = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(id) || !Number.isInteger(messageId)) {
      return badRequest(res, "Invalid id");
    }
    try {
      const user = req.user!;
      const { convo, message } = await getOwnedProposalMessage(user.firm_id, id, messageId);
      if (!convo || !message) return notFound(res, "Message not found");
      if (!message.proposal) return badRequest(res, "This message has no proposed action");
      if (message.proposalStatus !== "pending") {
        return badRequest(res, `Action already ${message.proposalStatus}`);
      }
      // ATOMIC: only cancel while still pending. Guards against a confirm
      // landing between the read above and this write — without the WHERE guard
      // a cancel could overwrite an already-executed action and hide its side
      // effects from the audit trail.
      const cancelled = await db
        .update(messages)
        .set({ proposalStatus: "cancelled" })
        .where(and(eq(messages.id, messageId), eq(messages.proposalStatus, "pending")))
        .returning({ id: messages.id });
      if (cancelled.length === 0) {
        return badRequest(res, "Action already in progress or completed");
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "sites-ai cancel proposal failed");
      serverError(res, "Failed to cancel action");
    }
  },
);

// ── POST /uploads/request-url — presigned upload URL for an attachment ────────
router.post(
  "/uploads/request-url",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req, res) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid request", parsed.error.flatten());
    // Enforce the MIME allowlist + size cap before minting a signed URL.
    //
    // NOTE: the Replit object-storage sidecar signs only {bucket, object,
    // method, expires} — it does NOT support content-length-range / content-type
    // conditions, so the cap cannot be bound into the signed PUT itself (this is
    // the app-wide upload pattern). We therefore HARD-enforce against the real
    // stored object metadata at attach time (verifyStoredAttachments) and again
    // in the extraction path, so an oversized/disallowed object can never be
    // used in chat or read cross-firm even if a client overwrites the URL.
    const policy = checkUploadPolicy(parsed.data.contentType, parsed.data.size);
    if (!policy.ok) return badRequest(res, policy.message);
    try {
      const user = req.user!;
      const uploadURL = await objectStorageService.getObjectEntityUploadURL(
        firmUploadPrefix(user.firm_id),
      );
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath, metadata: parsed.data });
    } catch (err) {
      logger.error({ err }, "sites-ai upload url failed");
      serverError(res, "Failed to generate upload URL");
    }
  },
);

// ── GET /conversations/:id/messages/:mid/attachments/:idx — serve a file ──────
// Firm-scoped: the attachment is only served if the message belongs to a Sites
// conversation owned by the caller's firm. Tenancy is enforced at the DB layer,
// not via storage ACLs.
router.get(
  "/conversations/:id/messages/:messageId/attachments/:index",
  requirePermission(Permission.FORMS_CONFIG_VIEW),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const index = Number(req.params.index);
    if (!Number.isInteger(id) || !Number.isInteger(messageId) || !Number.isInteger(index)) {
      return badRequest(res, "Invalid id");
    }
    try {
      const user = req.user!;
      const { convo, message } = await getOwnedProposalMessage(user.firm_id, id, messageId);
      if (!convo || !message) return notFound(res, "Attachment not found");
      const list = (message.attachments ?? []) as MessageAttachment[];
      const att = list[index];
      if (!att) return notFound(res, "Attachment not found");
      // Defense in depth: only ever serve objects under this firm's prefix.
      if (!att.objectPath.startsWith(firmObjectPathPrefix(user.firm_id))) {
        return notFound(res, "Attachment not found");
      }

      const objectFile = await objectStorageService.getObjectEntityFile(att.objectPath);
      const response = await objectStorageService.downloadObject(objectFile);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return notFound(res, "Attachment not found");
      logger.error({ err }, "sites-ai serve attachment failed");
      serverError(res, "Failed to serve attachment");
    }
  },
);

export default router;
