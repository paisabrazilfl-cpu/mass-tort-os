// FAVORITES router — per-user saved URLs (bookmarks).
//
//   GET    /api/favorites        — list the current user's favorites
//   POST   /api/favorites        — add a single favorite { url, label? }
//   POST   /api/favorites/bulk   — add many { urls: string[] } (one per line/comma)
//   PATCH  /api/favorites/:id     — edit a favorite { url?, label? }
//   DELETE /api/favorites/:id     — remove a favorite
//
// All routes require authentication. Rows are scoped to the calling user
// (req.user.id); firm_id is recorded for tenancy/reporting.

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, favoritesTable } from "@workspace/db";
import { z } from "zod/v4";
import { authMiddleware, auditAction } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";

const router = Router();
router.use(authMiddleware);

// Accept a bare host ("example.com") or a full URL and normalize to a valid
// absolute http(s) URL. Returns null when it can't be made into one.
function normalizeUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const createSchema = z.object({
  url: z.string().min(1).max(2048),
  label: z.string().max(255).nullish(),
});

const bulkSchema = z.object({
  // Either a single newline/comma-delimited blob or an explicit array.
  urls: z.union([z.string().min(1), z.array(z.string().min(1))]),
});

const updateSchema = z
  .object({
    url: z.string().min(1).max(2048).optional(),
    label: z.string().max(255).nullish(),
  })
  .refine((v) => v.url !== undefined || v.label !== undefined, {
    message: "Provide url and/or label to update",
  });

router.get("/", async (req, res) => {
  const userId = req.user!.id;
  const rows = await db
    .select()
    .from(favoritesTable)
    .where(eq(favoritesTable.user_id, userId))
    .orderBy(desc(favoritesTable.created_at));
  res.json(rows);
});

router.post("/", auditAction("create_favorite"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const url = normalizeUrl(parsed.data.url);
  if (!url) {
    badRequest(res, "invalid_url", "That doesn't look like a valid URL");
    return;
  }
  const label = parsed.data.label?.trim() || null;
  const [row] = await db
    .insert(favoritesTable)
    .values({
      user_id: req.user!.id,
      firm_id: req.user!.firm_id ?? null,
      url,
      label,
    })
    .returning();
  res.status(201).json(row);
});

router.post("/bulk", auditAction("create_favorites_bulk"), async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  const raw = Array.isArray(parsed.data.urls)
    ? parsed.data.urls
    : parsed.data.urls.split(/[\n,]+/);

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const candidate of raw) {
    const piece = candidate.trim();
    if (!piece) continue;
    const norm = normalizeUrl(piece);
    if (!norm) {
      invalid.push(piece);
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    valid.push(norm);
  }

  if (valid.length === 0) {
    badRequest(res, "no_valid_urls", "No valid URLs were found in the input");
    return;
  }

  const inserted = await db
    .insert(favoritesTable)
    .values(
      valid.map((url) => ({
        user_id: req.user!.id,
        firm_id: req.user!.firm_id ?? null,
        url,
        label: null,
      })),
    )
    .returning();

  res.status(201).json({ created: inserted, addedCount: inserted.length, skipped: invalid });
});

router.patch("/:id", auditAction("update_favorite"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }

  const patch: { url?: string; label?: string | null; updated_at: Date } = {
    updated_at: new Date(),
  };
  if (parsed.data.url !== undefined) {
    const url = normalizeUrl(parsed.data.url);
    if (!url) {
      badRequest(res, "invalid_url", "That doesn't look like a valid URL");
      return;
    }
    patch.url = url;
  }
  if (parsed.data.label !== undefined) {
    patch.label = parsed.data.label?.trim() || null;
  }

  const [row] = await db
    .update(favoritesTable)
    .set(patch)
    .where(and(eq(favoritesTable.id, id), eq(favoritesTable.user_id, req.user!.id)))
    .returning();
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json(row);
});

router.delete("/:id", auditAction("delete_favorite"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const [row] = await db
    .delete(favoritesTable)
    .where(and(eq(favoritesTable.id, id), eq(favoritesTable.user_id, req.user!.id)))
    .returning();
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json({ ok: true, id });
});

export default router;
