const US_STATES: Set<string> = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
]);

const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;
const STREET_PATTERN = /\d+\s+\S+/;

// Hoisted static regex patterns to avoid redundant allocations.
const GARBAGE_PATTERNS = [
  /^[x]+$/i,
  /^[0]+$/,
  /^test$/i,
  /^asdf$/i,
  /^na$/i,
  /^none$/i,
];

export interface AddressValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAddress(address: {
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
}): AddressValidationResult {
  const errors: string[] = [];

  const street = address.street_address?.trim();
  const city = address.city?.trim();
  const state = address.state?.trim();
  const zip = address.zip?.trim();

  if (!street) {
    errors.push("MISSING_STREET");
  } else if (!STREET_PATTERN.test(street)) {
    errors.push("INVALID_STREET_FORMAT");
  }

  if (!city) {
    errors.push("MISSING_CITY");
  } else if (city.length < 2) {
    errors.push("INVALID_CITY");
  }

  if (!state) {
    errors.push("MISSING_STATE");
  } else if (!US_STATES.has(state.toUpperCase())) {
    errors.push("INVALID_STATE_CODE");
  }

  if (!zip) {
    errors.push("MISSING_ZIP");
  } else if (!US_ZIP_REGEX.test(zip)) {
    errors.push("INVALID_ZIP_FORMAT");
  }

  const fieldsToCheck = [street, city];
  for (const field of fieldsToCheck) {
    if (field) {
      // field is already trimmed
      for (const pat of GARBAGE_PATTERNS) {
        if (pat.test(field)) {
          errors.push("GARBAGE_ADDRESS_DATA");
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
