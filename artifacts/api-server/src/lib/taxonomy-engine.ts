import { logger } from "./logger";

const ONCOLOGY_TAXONOMIES = new Set([
  "207RH0003X", "207RX0202X", "2080H0002X",
  "207VX0000X", "2080P0006X", "208D00000X",
  "207RI0200X", "207RG0300X",
]);

const TAXONOMY_DIAGNOSIS_MAP: Record<string, string[]> = {
  "neurology": [
    "parkinson", "parkinsons", "parkinsonism", "brain tumor", "meningioma",
    "traumatic brain injury", "neurological", "neuropathy",
  ],
  "gynecology": [
    "ovarian cancer", "uterine cancer", "endometrial cancer", "uterine fibroids",
  ],
  "gastroenterology": [
    "gastroparesis", "gi injury", "gastrointestinal", "bowel obstruction",
    "pancreatitis", "gallbladder", "necrotizing enterocolitis", "nec",
    "stomach paralysis", "intestinal",
  ],
  "hematology": [
    "leukemia", "lymphoma", "myeloma", "aplastic anemia", "myelodysplastic",
    "non-hodgkin", "hodgkin", "aml", "cll", "blood cancer",
  ],
  "oncology": [
    "cancer", "carcinoma", "mesothelioma", "melanoma",
    "sarcoma", "tumor", "neoplasm", "metastatic", "malignant",
    "renal cell", "bladder cancer", "kidney cancer",
    "liver cancer", "lung cancer",
    "testicular cancer", "thyroid cancer", "pancreatic cancer", "gastric cancer",
    "esophageal cancer", "colorectal cancer", "prostate cancer", "breast cancer",
  ],
  "orthopedics": [
    "metallosis", "implant failure", "revision surgery", "bone deterioration",
    "chronic pain", "hernia", "mesh migration", "organ damage", "pseudotumor",
  ],
  "pulmonology": [
    "respiratory injury", "lung cancer", "mesothelioma", "asbestosis",
    "pleural disease", "pleural thickening", "foam degradation",
    "respiratory", "cpap",
  ],
  "psychiatry": [
    "ptsd", "psychological trauma", "psychological harm", "addiction",
    "depression", "anxiety", "self-harm", "eating disorder",
    "suicidal ideation", "behavioral harm", "mental health",
    "autism", "adhd", "attention deficit",
  ],
  "general_surgery": [
    "assault", "physical injury", "collision injury", "spinal injury",
    "wrongful death", "workplace injury", "battery", "accident",
    "sexual assault",
  ],
  "urology": [
    "bladder cancer", "kidney cancer", "testicular cancer", "prostate cancer",
  ],
};

const SPECIALTY_CATEGORY_MAP: Record<string, string[]> = {
  "oncology": ["oncology", "hematology/oncology", "medical oncology", "surgical oncology", "gynecologic oncology", "hematology", "neuro-oncology"],
  "hematology": ["hematology", "hematology/oncology", "pathology"],
  "neurology": ["neurology", "neurological surgery", "neuro-oncology", "neuropsychiatry"],
  "gastroenterology": ["gastroenterology", "internal medicine", "pediatrics", "neonatology"],
  "orthopedics": ["orthopedic surgery", "surgery", "pain medicine", "general surgery"],
  "pulmonology": ["pulmonary disease", "pulmonology", "critical care medicine", "internal medicine"],
  "psychiatry": ["psychiatry", "psychology", "child psychiatry", "behavioral health"],
  "general_surgery": ["surgery", "emergency medicine", "trauma surgery", "general practice", "family medicine"],
  "gynecology": ["obstetrics & gynecology", "gynecology", "gynecologic oncology", "reproductive medicine"],
  "urology": ["urology", "urologic surgery", "urological oncology"],
};

export interface TaxonomyMatchResult {
  matched: boolean;
  physician_specialty: string;
  expected_specialties: string[];
  diagnosis_category: string | null;
  fraud_indicators: string[];
  confidence: "high" | "medium" | "low";
}

export function matchTaxonomyToDiagnosis(
  physicianSpecialty: string,
  diagnosis: string,
  npiTaxonomyCode?: string
): TaxonomyMatchResult {
  const specLower = physicianSpecialty.toLowerCase().trim();
  const diagLower = diagnosis.toLowerCase().trim();
  const fraudIndicators: string[] = [];

  let diagnosisCategory: string | null = null;
  for (const [category, diagnoses] of Object.entries(TAXONOMY_DIAGNOSIS_MAP)) {
    if (diagnoses.some(d => diagLower.includes(d))) {
      diagnosisCategory = category;
      break;
    }
  }

  if (!diagnosisCategory) {
    return {
      matched: false,
      physician_specialty: physicianSpecialty,
      expected_specialties: [],
      diagnosis_category: null,
      fraud_indicators: ["UNRECOGNIZED_DIAGNOSIS"],
      confidence: "low",
    };
  }

  const expectedSpecialties = SPECIALTY_CATEGORY_MAP[diagnosisCategory] || [];

  const isMatch = expectedSpecialties.some(expected => specLower.includes(expected.toLowerCase()));

  const isGeneralist = ["internal medicine", "family medicine", "general practice", "general practitioner", "primary care"].some(g => specLower.includes(g));

  if (!isMatch && !isGeneralist) {
    fraudIndicators.push("TAXONOMY_MISMATCH");

    const isPediatric = specLower.includes("pediatr") || specLower.includes("child");
    const isAdultCondition = ["cancer", "carcinoma", "lymphoma", "leukemia", "mesothelioma", "parkinson"].some(c => diagLower.includes(c));
    if (isPediatric && isAdultCondition) {
      fraudIndicators.push("PEDIATRIC_PHYSICIAN_ADULT_CONDITION");
    }

    const isDermatology = specLower.includes("dermat");
    const isCancerClaim = ["cancer", "carcinoma", "lymphoma", "leukemia", "mesothelioma"].some(c => diagLower.includes(c));
    if (isDermatology && isCancerClaim) {
      fraudIndicators.push("SPECIALTY_OUTSIDE_SCOPE");
    }

    const isDentist = specLower.includes("dent") || specLower.includes("orthodont");
    if (isDentist) {
      fraudIndicators.push("NON_MEDICAL_PROVIDER");
    }
  }

  if (npiTaxonomyCode && ONCOLOGY_TAXONOMIES.has(npiTaxonomyCode)) {
    const isCancerDiag = TAXONOMY_DIAGNOSIS_MAP["oncology"].some(d => diagLower.includes(d));
    if (isCancerDiag) {
      return {
        matched: true,
        physician_specialty: physicianSpecialty,
        expected_specialties: expectedSpecialties,
        diagnosis_category: diagnosisCategory,
        fraud_indicators: [],
        confidence: "high",
      };
    }
  }

  const confidence = isMatch ? "high" : isGeneralist ? "medium" : "low";

  return {
    matched: isMatch || isGeneralist,
    physician_specialty: physicianSpecialty,
    expected_specialties: expectedSpecialties,
    diagnosis_category: diagnosisCategory,
    fraud_indicators,
    confidence,
  };
}

export async function lookupNpiAndMatch(
  physicianFirstName: string,
  physicianLastName: string,
  diagnosis: string
): Promise<{
  npi_found: boolean;
  npi_number: string | null;
  specialty: string | null;
  taxonomy_match: TaxonomyMatchResult | null;
  error: string | null;
}> {
  try {
    const params = new URLSearchParams({
      version: "2.1",
      first_name: physicianFirstName,
      last_name: physicianLastName,
      limit: "5",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { npi_found: false, npi_number: null, specialty: null, taxonomy_match: null, error: "NPI_API_UNAVAILABLE" };
    }

    const data = await response.json() as { results?: Array<{ number?: number; taxonomies?: Array<{ desc?: string; code?: string; primary?: boolean }> }> };

    if (!data.results || data.results.length === 0) {
      return { npi_found: false, npi_number: null, specialty: null, taxonomy_match: null, error: "NPI_NOT_FOUND" };
    }

    const provider = data.results[0];
    const npiNumber = String(provider.number || "");
    const taxonomies = provider.taxonomies || [];
    const primaryTax = taxonomies.find((t: { primary?: boolean }) => t.primary) || taxonomies[0] || {};
    const specialty = primaryTax.desc || "Unknown";
    const taxonomyCode = primaryTax.code || undefined;

    const taxonomyMatch = matchTaxonomyToDiagnosis(specialty, diagnosis, taxonomyCode);

    return {
      npi_found: true,
      npi_number: npiNumber,
      specialty,
      taxonomy_match: taxonomyMatch,
      error: null,
    };
  } catch (err) {
    logger.warn({ err }, "NPI taxonomy lookup failed");
    return { npi_found: false, npi_number: null, specialty: null, taxonomy_match: null, error: "NPI_LOOKUP_FAILED" };
  }
}
