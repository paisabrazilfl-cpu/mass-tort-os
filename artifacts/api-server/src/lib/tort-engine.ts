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
    // 2026 update: NHL subtypes per MDL 2741 case management order; multiple myeloma added
    // following 2024 Bayer settlement framework expansion.
    valid_diagnoses: [
      "non-hodgkin lymphoma", "nhl", "b-cell lymphoma", "t-cell lymphoma",
      "diffuse large b-cell lymphoma", "dlbcl", "follicular lymphoma",
      "mantle cell lymphoma", "burkitt lymphoma", "marginal zone lymphoma",
      "hairy cell leukemia", "primary cutaneous lymphoma", "cutaneous t-cell lymphoma",
      "chronic lymphocytic leukemia", "cll",
      "multiple myeloma"
    ],
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
    // 2026 update: ulcerative colitis and hypothyroidism added per MDL 2873
    // (D.S.C.) updated qualifying-injury list. Breast cancer accepted in
    // Tier 2 review as of late-2025 case management orders.
    valid_diagnoses: [
      "kidney cancer", "testicular cancer", "thyroid cancer",
      "bladder cancer", "prostate cancer", "liver cancer", "pancreatic cancer",
      "ulcerative colitis", "hypothyroidism", "thyroid disease",
      "breast cancer", "non-hodgkin lymphoma", "leukemia"
    ],
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
  "suboxone": {
    id: "suboxone",
    label: "Suboxone (Tooth Decay)",
    category: "pharmaceutical",
    valid_diagnoses: [
      "tooth decay", "dental decay", "tooth loss", "tooth extraction",
      "dental erosion", "enamel erosion", "cavities", "caries",
      "periodontal disease", "gum disease", "oral infection", "root canal"
    ],
    required_exposure: true,
    exposure_fields: ["exposure_start", "exposure_end"],
    extra_fields: [],
    rules: ["EXPOSURE_DATES_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "paragard": {
    id: "paragard",
    label: "Paragard IUD",
    category: "medical_device",
    valid_diagnoses: [
      "iud breakage", "device breakage", "device fracture", "iud fracture",
      "uterine perforation", "perforation", "device migration", "embedment",
      "infection", "ectopic pregnancy", "hysterectomy", "removal surgery",
      "pelvic inflammatory disease", "pid", "infertility"
    ],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "bard-powerport": {
    id: "bard-powerport",
    label: "Bard PowerPort",
    category: "medical_device",
    valid_diagnoses: [
      "catheter fracture", "device fracture", "catheter migration",
      "blood clot", "deep vein thrombosis", "dvt", "pulmonary embolism", "pe",
      "infection", "sepsis", "bloodstream infection", "perforation",
      "cardiac tamponade", "arrhythmia", "necrosis", "tissue damage",
      "revision surgery", "device failure"
    ],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "ozempic": {
    id: "ozempic",
    label: "Ozempic / Mounjaro / Wegovy",
    category: "pharmaceutical",
    valid_diagnoses: [
      "gastroparesis", "stomach paralysis", "delayed gastric emptying",
      "ileus", "intestinal obstruction", "bowel obstruction", "small bowel obstruction",
      "deep vein thrombosis", "pulmonary embolism",
      "gallbladder disease", "cholecystitis", "gallstones", "cholelithiasis",
      "pancreatitis", "acute pancreatitis", "vision loss", "naion",
      "non-arteritic anterior ischemic optic neuropathy"
    ],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: ["medications"],
    rules: [],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "exactech": {
    id: "exactech",
    label: "Exactech Hip/Knee/Ankle Implant",
    category: "medical_device",
    valid_diagnoses: [
      "implant failure", "polyethylene wear", "osteolysis", "bone loss",
      "revision surgery", "loosening", "instability", "dislocation",
      "chronic pain", "metallosis", "device failure"
    ],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: ["DIAGNOSIS_MISMATCH"],
  },
  "tepezza": {
    id: "tepezza",
    label: "Tepezza (Hearing Loss)",
    category: "pharmaceutical",
    // 2026 update: MDL 3079 (N.D. Ill.) — qualifying injuries center on
    // ototoxicity. Patulous eustachian tube added as a recognized injury.
    valid_diagnoses: [
      "hearing loss", "permanent hearing loss", "sensorineural hearing loss",
      "tinnitus", "ringing in ears", "ear pain", "ototoxicity",
      "patulous eustachian tube", "autophony", "deafness"
    ],
    required_exposure: true,
    exposure_fields: ["exposure_start"],
    extra_fields: ["medications"],
    rules: [],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
  },
  "philips-cpap": {
    id: "philips-cpap",
    label: "Philips CPAP/BiPAP Recall",
    category: "medical_device",
    valid_diagnoses: [
      "lung cancer", "kidney cancer", "liver cancer", "nasal cancer",
      "throat cancer", "sinus cancer", "respiratory failure",
      "chemical poisoning", "pulmonary fibrosis", "asthma exacerbation",
      "chronic bronchitis", "copd", "foam degradation injury",
      "reactive airway disease"
    ],
    required_exposure: true,
    exposure_fields: ["exposure_start", "exposure_end"],
    extra_fields: [],
    rules: ["EXPOSURE_DATES_REQUIRED"],
    rejection_conditions: ["NO_EXPOSURE", "DIAGNOSIS_MISMATCH"],
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

  if (tort.required_exposure) {
    const requiresStart = tort.exposure_fields.includes("exposure_start");
    const hasStart = !!(data.exposure_start && data.exposure_start.trim());
    if (requiresStart && !hasStart && !data.was_at_location) {
      errors.push("NO_EXPOSURE");
    } else if (!requiresStart && !hasStart && !data.was_at_location) {
      errors.push("NO_EXPOSURE");
    }
  }

  for (const rule of tort.rules) {
    if (rule === "LOCATION_REQUIRED" && (!data.location_name || !data.location_name.trim())) {
      errors.push("TORT_RULE:LOCATION_REQUIRED");
    }
    if (rule === "EXPOSURE_DATES_REQUIRED") {
      if (!data.exposure_start || !data.exposure_start.trim()) {
        errors.push("TORT_RULE:EXPOSURE_DATES_REQUIRED");
      } else if (tort.exposure_fields.includes("exposure_end") && (!data.exposure_end || !data.exposure_end.trim())) {
        errors.push("TORT_RULE:EXPOSURE_END_REQUIRED");
      }
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
