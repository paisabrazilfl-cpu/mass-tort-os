export interface TortDefinition {
  id: string;
  label: string;
  category: "pharmaceutical" | "product_liability" | "medical_device" | "environmental" | "transportation" | "digital_platform";
  valid_diagnoses: string[];
  required_exposure: boolean;
  exposure_fields: string[];
  extra_fields: string[];
  rules: string[];
  rejection_conditions: string[];
}

export const TORT_REGISTRY: Record<string, TortDefinition> = {
  "roundup": {
    id: "roundup",
    label: "Roundup",
    category: "pharmaceutical",
    valid_diagnoses: ["non-hodgkin lymphoma", "nhl", "b-cell lymphoma", "diffuse large b-cell lymphoma", "follicular lymphoma", "mantle cell lymphoma", "burkitt lymphoma"],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "paraquat": {
    id: "paraquat",
    label: "Paraquat",
    category: "pharmaceutical",
    valid_diagnoses: ["parkinson's disease", "parkinsons disease", "parkinson", "parkinsonism"],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "zantac": {
    id: "zantac",
    label: "Zantac",
    category: "pharmaceutical",
    valid_diagnoses: ["bladder cancer", "stomach cancer", "gastric cancer", "esophageal cancer", "liver cancer", "pancreatic cancer", "kidney cancer", "colorectal cancer", "ndma"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "depo-provera": {
    id: "depo-provera",
    label: "Depo-Provera",
    category: "pharmaceutical",
    valid_diagnoses: ["meningioma", "brain tumor", "intracranial meningioma", "benign brain tumor"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "glp1": {
    id: "glp1",
    label: "GLP-1 Drugs",
    category: "pharmaceutical",
    valid_diagnoses: ["gastroparesis", "stomach paralysis", "gi injury", "gastrointestinal injury", "bowel obstruction", "pancreatitis", "gallbladder disease"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: ["medications"],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "talcum-powder": {
    id: "talcum-powder",
    label: "Talcum Powder",
    category: "product_liability",
    valid_diagnoses: ["ovarian cancer", "mesothelioma", "endometrial cancer"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "hair-relaxer": {
    id: "hair-relaxer",
    label: "Hair Relaxer",
    category: "product_liability",
    valid_diagnoses: ["uterine cancer", "endometrial cancer", "ovarian cancer", "uterine fibroids"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "asbestos": {
    id: "asbestos",
    label: "Asbestos",
    category: "product_liability",
    valid_diagnoses: ["mesothelioma", "lung cancer", "asbestosis", "pleural disease", "pleural thickening"],
    required_exposure: true,
    exposure_fields: ["exposure_start", "exposure_end"],
    extra_fields: ["location_name"],
    rules: ["LOCATION_REQUIRED", "EXPOSURE_DATES_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "NO_LOCATION", "DIAGNOSIS_MISMATCH"],
  },
  "benzene": {
    id: "benzene",
    label: "Benzene",
    category: "product_liability",
    valid_diagnoses: ["leukemia", "acute myeloid leukemia", "aml", "chronic lymphocytic leukemia", "cll", "non-hodgkin lymphoma", "myelodysplastic syndrome", "aplastic anemia"],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: ["location_name"],
    rules: [],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "hernia-mesh": {
    id: "hernia-mesh",
    label: "Hernia Mesh",
    category: "medical_device",
    valid_diagnoses: ["chronic pain", "mesh migration", "organ damage", "bowel obstruction", "infection", "hernia recurrence", "adhesion", "fistula"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "hip-implants": {
    id: "hip-implants",
    label: "Hip Implants",
    category: "medical_device",
    valid_diagnoses: ["metallosis", "metal poisoning", "revision surgery", "implant failure", "bone deterioration", "pseudotumor", "chronic pain"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "ivc-filters": {
    id: "ivc-filters",
    label: "IVC Filters",
    category: "medical_device",
    valid_diagnoses: ["filter migration", "filter fracture", "organ perforation", "pulmonary embolism", "deep vein thrombosis", "death"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "cpap": {
    id: "cpap",
    label: "CPAP Devices",
    category: "medical_device",
    valid_diagnoses: ["respiratory injury", "lung cancer", "kidney cancer", "liver cancer", "nasal cancer", "foam degradation injury"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "camp-lejeune": {
    id: "camp-lejeune",
    label: "Camp Lejeune",
    category: "environmental",
    valid_diagnoses: ["kidney cancer", "leukemia", "liver cancer", "bladder cancer", "parkinson's disease", "parkinsons disease", "non-hodgkin lymphoma", "multiple myeloma", "aplastic anemia"],
    required_exposure: true,
    exposure_fields: ["exposure_start", "exposure_end"],
    extra_fields: ["location_name"],
    rules: ["LOCATION_REQUIRED", "EXPOSURE_DATES_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "NO_LOCATION", "DIAGNOSIS_MISMATCH", "EXPOSURE_OUTSIDE_1953_1987"],
  },
  "afff": {
    id: "afff",
    label: "AFFF / PFAS",
    category: "environmental",
    valid_diagnoses: ["kidney cancer", "testicular cancer", "thyroid cancer", "bladder cancer", "prostate cancer", "liver cancer", "pancreatic cancer"],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: ["location_name"],
    rules: ["LOCATION_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "industrial-water": {
    id: "industrial-water",
    label: "Industrial Water Contamination",
    category: "environmental",
    valid_diagnoses: ["cancer", "kidney cancer", "liver cancer", "leukemia", "bladder cancer", "non-hodgkin lymphoma"],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: ["location_name"],
    rules: ["LOCATION_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "rideshare-assault": {
    id: "rideshare-assault",
    label: "Uber/Lyft Assault",
    category: "transportation",
    valid_diagnoses: ["sexual assault", "physical injury", "battery", "assault", "ptsd", "psychological trauma"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "delivery-injury": {
    id: "delivery-injury",
    label: "Delivery Platform Injury",
    category: "transportation",
    valid_diagnoses: ["workplace injury", "assault", "physical injury", "wrongful termination", "accident"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "autonomous-vehicles": {
    id: "autonomous-vehicles",
    label: "Autonomous Vehicles",
    category: "transportation",
    valid_diagnoses: ["collision injury", "wrongful death", "traumatic brain injury", "spinal injury", "physical injury"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "roblox": {
    id: "roblox",
    label: "Roblox Injury Cases",
    category: "digital_platform",
    valid_diagnoses: ["psychological harm", "exploitation", "child exploitation", "addiction", "behavioral harm"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "social-media": {
    id: "social-media",
    label: "Social Media Harm",
    category: "digital_platform",
    valid_diagnoses: ["addiction", "mental health", "depression", "anxiety", "self-harm", "eating disorder", "suicidal ideation"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "online-gaming": {
    id: "online-gaming",
    label: "Online Gaming Exposure",
    category: "digital_platform",
    valid_diagnoses: ["behavioral harm", "addiction", "psychological harm", "exploitation"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "nec": {
    id: "nec",
    label: "Necrotizing Enterocolitis",
    category: "pharmaceutical",
    valid_diagnoses: ["necrotizing enterocolitis", "nec", "bowel injury", "intestinal injury"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "tylenol": {
    id: "tylenol",
    label: "Tylenol",
    category: "pharmaceutical",
    valid_diagnoses: ["autism", "adhd", "autism spectrum disorder", "attention deficit"],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
};

export interface TortValidationResult {
  valid: boolean;
  tort_id: string | null;
  errors: string[];
  diagnosis_match: boolean;
  category: string | null;
}

export function validateTortClaim(data: {
  tort_type: string;
  diagnosis: string;
  exposure_start?: string;
  exposure_end?: string;
  location_name?: string;
  was_at_location?: boolean;
}): TortValidationResult {
  const errors: string[] = [];

  const tortKey = Object.keys(TORT_REGISTRY).find(
    k => TORT_REGISTRY[k].label.toLowerCase() === data.tort_type.toLowerCase() || k === data.tort_type.toLowerCase()
  );

  if (!tortKey) {
    return {
      valid: false,
      tort_id: null,
      errors: ["UNKNOWN_TORT_TYPE"],
      diagnosis_match: false,
      category: null,
    };
  }

  const tort = TORT_REGISTRY[tortKey];
  const diagLower = data.diagnosis.toLowerCase().trim();
  const diagnosisMatch = tort.valid_diagnoses.some(d => diagLower.includes(d) || d.includes(diagLower));

  if (!diagnosisMatch) {
    errors.push("DIAGNOSIS_MISMATCH");
  }

  if (tort.required_exposure && !data.exposure_start && !data.was_at_location) {
    errors.push("NO_EXPOSURE");
  }

  for (const rule of tort.rules) {
    if (rule === "LOCATION_REQUIRED" && (!data.location_name || !data.location_name.trim())) {
      errors.push("TORT_RULE:LOCATION_REQUIRED");
    }
    if (rule === "EXPOSURE_DATES_REQUIRED" && (!data.exposure_start || !data.exposure_start.trim())) {
      errors.push("TORT_RULE:EXPOSURE_DATES_REQUIRED");
    }
  }

  if (tortKey === "camp-lejeune" && data.exposure_start) {
    const startYear = new Date(data.exposure_start).getFullYear();
    if (startYear < 1953 || startYear > 1987) {
      errors.push("EXPOSURE_OUTSIDE_1953_1987");
    }
  }

  return {
    valid: errors.length === 0,
    tort_id: tortKey,
    errors,
    diagnosis_match: diagnosisMatch,
    category: tort.category,
  };
}

export function getTortCategories(): { category: string; torts: { id: string; label: string }[] }[] {
  const categories: Record<string, { id: string; label: string }[]> = {};
  for (const [id, tort] of Object.entries(TORT_REGISTRY)) {
    if (!categories[tort.category]) categories[tort.category] = [];
    categories[tort.category].push({ id, label: tort.label });
  }
  return Object.entries(categories).map(([category, torts]) => ({ category, torts }));
}
