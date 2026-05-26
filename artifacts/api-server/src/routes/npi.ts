import { Router } from "express";
import { VerifyProviderMatchBody } from "@workspace/api-zod";
import { db, nppsProvidersTable } from "@workspace/db";
import { and, or, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { Permission, requirePermission } from "../lib/rbac";
import { badRequest, errorEnvelope, notFound } from "../lib/http-errors";
import { verifyProvider } from "../lib/npi-verify";

const router = Router();

const NPI_API_BASE = "https://npiregistry.cms.hhs.gov/api/";

interface NpiResult {
  npi: string;
  provider_type: string;
  name: string;
  first_name: string;
  last_name: string;
  credential: string;
  gender: string;
  specialty: string;
  address_line_1: string;
  address_line_2: string;
  city: string;
  state: string;
  postal_code: string;
  phone: string;
  fax: string;
  enumeration_date: string;
  last_updated: string;
  npi_registry_url: string;
}

function parseNpiResponse(data: any): NpiResult[] {
  if (!data.results || !Array.isArray(data.results)) return [];

  return data.results.map((r: any) => {
    const basic = r.basic || {};
    const isOrg = r.enumeration_type === "NPI-2";

    const addresses = r.addresses || [];
    const practiceAddr = addresses.find((a: any) => a.address_purpose === "LOCATION") || addresses[0] || {};

    const taxonomies = r.taxonomies || [];
    // Prefer the primary taxonomy that has a description; if the primary entry
    // has desc=null (happens for multi-specialty groups), fall back to the
    // first taxonomy with any desc, then to the raw first entry.
    const primaryTax =
      taxonomies.find((t: any) => t.primary && t.desc) ||
      taxonomies.find((t: any) => t.desc) ||
      taxonomies[0] ||
      {};

    return {
      npi: String(r.number || ""),
      provider_type: isOrg ? "Organization" : "Individual",
      name: isOrg
        ? (basic.organization_name || "")
        : `${basic.first_name || ""} ${basic.last_name || ""}`.trim(),
      first_name: basic.first_name || "",
      last_name: basic.last_name || "",
      credential: basic.credential || "",
      gender: basic.gender || "",
      specialty: primaryTax.desc || "",
      address_line_1: practiceAddr.address_1 || "",
      address_line_2: practiceAddr.address_2 || "",
      city: practiceAddr.city || "",
      state: practiceAddr.state || "",
      postal_code: practiceAddr.postal_code || "",
      phone: practiceAddr.telephone_number || "",
      fax: practiceAddr.fax_number || "",
      enumeration_date: basic.enumeration_date || "",
      last_updated: basic.last_updated || "",
      npi_registry_url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
    };
  });
}

router.get("/search", requirePermission(Permission.NPI_LOOKUP), async (req, res) => {
  const {
    npi_number,
    first_name,
    last_name,
    city,
    state,
    specialty,
    limit,
  } = req.query as Record<string, string | undefined>;

  const params = new URLSearchParams({ version: "2.1" });

  if (npi_number) params.set("number", npi_number);
  if (first_name) params.set("first_name", first_name);
  if (last_name) params.set("last_name", last_name);
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (specialty) params.set("taxonomy_description", specialty);
  params.set("limit", limit || "20");

  const hasSearchCriteria = npi_number || first_name || last_name || city || state || specialty;
  if (!hasSearchCriteria) {
    badRequest(res, "At least one search parameter is required");
    return;
  }

  try {
    const url = `${NPI_API_BASE}?${params.toString()}`;
    logger.info({ url }, "NPI Registry query");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`NPI API returned ${response.status}`);
    }

    const data = (await response.json()) as { result_count?: number; results?: unknown[] };
    const results = parseNpiResponse(data);
    const result_count = data.result_count || results.length;

    res.json({ results, result_count });
  } catch (err) {
    logger.error({ err }, "NPI Registry lookup failed");
    errorEnvelope(res, 502, "upstream_error", "NPI Registry lookup failed");
  }
});

router.get("/lookup/:npi", requirePermission(Permission.NPI_LOOKUP), async (req, res) => {
  const npi = String(req.params.npi);

  if (!/^\d{10}$/.test(npi)) {
    badRequest(res, "NPI must be a 10-digit number");
    return;
  }

  try {
    const url = `${NPI_API_BASE}?version=2.1&number=${npi}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`NPI API returned ${response.status}`);
    }

    const data = await response.json();
    const results = parseNpiResponse(data);

    if (results.length === 0) {
      notFound(res, "NPI not found");
      return;
    }

    res.json(results[0]);
  } catch (err) {
    logger.error({ err }, "NPI lookup failed");
    errorEnvelope(res, 502, "upstream_error", "NPI Registry lookup failed");
  }
});

// Verify a claimed provider against the registry — see lib/npi-verify.ts for
// strategy and decision thresholds. Distinct from /api/forms/npi-verify which
// is the lighter taxonomy-only check used by the public form pipeline; this
// endpoint is the operator-facing rich verify with per-field scoring.
router.post("/verify", requirePermission(Permission.NPI_LOOKUP), async (req, res) => {
  // Validate via the generated Zod schema (parity with the rest of the API).
  // This catches non-string fields, malformed bodies, etc., and returns a
  // structured 400 instead of crashing inside verifyProvider().
  const parsed = VerifyProviderMatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? "invalid request body");
    return;
  }
  const npi = (parsed.data.npi ?? "").trim();
  const expected = parsed.data.expected ?? {};
  const hasAnyExpected = Boolean(
    expected.name || expected.organization || expected.city || expected.state || expected.specialty,
  );
  if (!npi && !hasAnyExpected) {
    badRequest(
      res,
      "Provide at least an NPI or one expected field (name, organization, city, state, specialty)",
    );
    return;
  }

  try {
    const result = await verifyProvider({ npi: npi || undefined, expected });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "NPI verify failed");
    errorEnvelope(res, 502, "upstream_error", "NPI Registry verification failed");
  }
});

// Search the locally-imported NPPES provider directory (9.5M records).
// Requires at least one filter to avoid a full-table scan on the count query.
router.get("/providers", requirePermission(Permission.NPI_LOOKUP), async (req, res) => {
  const raw = req.query as Record<string, string | undefined>;
  const search = raw.search?.trim() || null;
  const state = raw.state?.trim().toUpperCase() || null;
  const entityType = raw.entity_type?.trim() || null; // "1" | "2"
  const hasFax = raw.has_fax === "true" ? true : raw.has_fax === "false" ? false : null;
  const page = Math.max(1, parseInt(raw.page || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(raw.page_size || "25") || 25));

  if (!search && !state && !entityType && hasFax === null) {
    badRequest(res, "Provide at least one filter: search, state, entity_type, or has_fax");
    return;
  }

  const conditions = [];
  if (search) conditions.push(ilike(nppsProvidersTable.display_name, `%${search}%`));
  if (state) conditions.push(or(eq(nppsProvidersTable.practice_state, state), eq(nppsProvidersTable.mail_state, state))!);
  if (entityType === "1" || entityType === "2") conditions.push(eq(nppsProvidersTable.entity_type, entityType));
  if (hasFax === true) conditions.push(or(isNotNull(nppsProvidersTable.practice_fax), isNotNull(nppsProvidersTable.mail_fax))!);

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];
  const offset = (page - 1) * pageSize;

  try {
    const [results, countRows] = await Promise.all([
      db
        .select({
          npi: nppsProvidersTable.npi,
          entity_type: nppsProvidersTable.entity_type,
          display_name: nppsProvidersTable.display_name,
          first_name: nppsProvidersTable.first_name,
          last_name: nppsProvidersTable.last_name,
          credential: nppsProvidersTable.credential,
          org_name: nppsProvidersTable.org_name,
          practice_city: nppsProvidersTable.practice_city,
          practice_state: nppsProvidersTable.practice_state,
          practice_zip: nppsProvidersTable.practice_zip,
          practice_phone: nppsProvidersTable.practice_phone,
          practice_fax: nppsProvidersTable.practice_fax,
          mail_city: nppsProvidersTable.mail_city,
          mail_state: nppsProvidersTable.mail_state,
          mail_phone: nppsProvidersTable.mail_phone,
          mail_fax: nppsProvidersTable.mail_fax,
          deactivation_date: nppsProvidersTable.deactivation_date,
          taxonomies: nppsProvidersTable.taxonomies,
        })
        .from(nppsProvidersTable)
        .where(where)
        .orderBy(nppsProvidersTable.display_name)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(nppsProvidersTable)
        .where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    res.json({ results, total, page, page_size: pageSize, has_more: offset + results.length < total });
  } catch (err) {
    logger.error({ err }, "NPPES local provider search failed");
    errorEnvelope(res, 500, "db_error", "Provider search failed");
  }
});

export default router;
