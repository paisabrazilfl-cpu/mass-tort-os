import { Router } from "express";
import { logger } from "../lib/logger";

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
    const primaryTax = taxonomies.find((t: any) => t.primary) || taxonomies[0] || {};

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

router.get("/search", async (req, res) => {
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
    res.status(400).json({ error: "At least one search parameter is required" });
    return;
  }

  try {
    const url = `${NPI_API_BASE}?${params.toString()}`;
    logger.info({ url }, "NPI Registry query");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`NPI API returned ${response.status}`);
    }

    const data = await response.json();
    const results = parseNpiResponse(data);
    const result_count = data.result_count || results.length;

    res.json({ results, result_count });
  } catch (err) {
    logger.error({ err }, "NPI Registry lookup failed");
    res.status(502).json({ error: "NPI Registry lookup failed" });
  }
});

router.get("/lookup/:npi", async (req, res) => {
  const { npi } = req.params;

  if (!/^\d{10}$/.test(npi)) {
    res.status(400).json({ error: "NPI must be a 10-digit number" });
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
      res.status(404).json({ error: "NPI not found" });
      return;
    }

    res.json(results[0]);
  } catch (err) {
    logger.error({ err }, "NPI lookup failed");
    res.status(502).json({ error: "NPI Registry lookup failed" });
  }
});

export default router;
