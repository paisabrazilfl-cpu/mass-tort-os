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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, favoritesTable } from "@workspace/db";
import { z } from "zod/v4";
import { authMiddleware, auditAction } from "../lib/rbac";
import { badRequest, notFound, conflict } from "../lib/http-errors";

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
  // Upsert on (user_id, url): re-saving a URL the user already has does NOT
  // create a second row. A new label overwrites the old; omitting the label
  // (null) keeps the existing one via COALESCE so a bare re-add never wipes it.
  const [row] = await db
    .insert(favoritesTable)
    .values({
      user_id: req.user!.id,
      firm_id: req.user!.firm_id ?? null,
      url,
      label,
    })
    .onConflictDoUpdate({
      target: [favoritesTable.user_id, favoritesTable.url],
      set: {
        label: sql`coalesce(excluded.label, ${favoritesTable.label})`,
        updated_at: new Date(),
      },
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

  // Skip URLs the user has already saved: look up existing rows for this user
  // among the candidate URLs, then only insert the ones that are genuinely new.
  const existingRows = await db
    .select({ url: favoritesTable.url })
    .from(favoritesTable)
    .where(and(eq(favoritesTable.user_id, req.user!.id), inArray(favoritesTable.url, valid)));
  const existing = new Set(existingRows.map((r) => r.url));
  const duplicates = valid.filter((url) => existing.has(url));
  const toInsert = valid.filter((url) => !existing.has(url));

  // onConflictDoNothing guards against a race where the same URL is inserted
  // concurrently (the unique (user_id, url) index would otherwise throw).
  const inserted =
    toInsert.length > 0
      ? await db
          .insert(favoritesTable)
          .values(
            toInsert.map((url) => ({
              user_id: req.user!.id,
              firm_id: req.user!.firm_id ?? null,
              url,
              label: null,
            })),
          )
          .onConflictDoNothing({ target: [favoritesTable.user_id, favoritesTable.url] })
          .returning()
      : [];

  res.status(201).json({
    created: inserted,
    addedCount: inserted.length,
    skipped: invalid,
    duplicates,
  });
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
    // Editing a favorite's URL to one the user already has would violate the
    // unique (user_id, url) index. Catch it here and report a friendly 409
    // instead of letting the DB throw a 500.
    const [clash] = await db
      .select({ id: favoritesTable.id })
      .from(favoritesTable)
      .where(and(eq(favoritesTable.user_id, req.user!.id), eq(favoritesTable.url, url)));
    if (clash && clash.id !== id) {
      conflict(res, "duplicate_url", "You've already saved that URL");
      return;
    }
  }
  if (parsed.data.label !== undefined) {
    patch.label = parsed.data.label?.trim() || null;
  }

  let row;
  try {
    [row] = await db
      .update(favoritesTable)
      .set(patch)
      .where(and(eq(favoritesTable.id, id), eq(favoritesTable.user_id, req.user!.id)))
      .returning();
  } catch (e) {
    // Backstop for the race the pre-check above can't cover: a concurrent
    // insert of the same (user_id, url) between the check and this update
    // trips the unique index (Postgres error 23505). Report it as a 409.
    if ((e as { code?: string }).code === "23505") {
      conflict(res, "duplicate_url", "You've already saved that URL");
      return;
    }
    throw e;
  }
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
