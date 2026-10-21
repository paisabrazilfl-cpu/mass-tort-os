const US_STATES: Set<string> = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
]);

const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;
const STREET_PATTERN = /\d+\s+\S+/;

// Hoisted to module scope to avoid re-instantiating 6 RegExp objects on every function call
const GARBAGE_PATTERNS = [/^[x]+$/i, /^[0]+$/, /^test$/i, /^asdf$/i, /^na$/i, /^none$/i];

export interface AddressValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates US address fields.
 * Performance optimizations:
 * 1. Pre-trims each address field into local variables to eliminate redundant `.trim()` calls & string allocations.
 * 2. Uses module-scoped `GARBAGE_PATTERNS` regex array to avoid per-call RegExp instantiation overhead.
 * 3. Eliminates temporary `fieldsToCheck` array allocations during garbage pattern inspection.
 */
export function validateAddress(address: {
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
}): AddressValidationResult {
  const errors: string[] = [];

  // Single-pass trimming
  const street = address.street_address?.trim();
  if (!street) {
    errors.push("MISSING_STREET");
  } else if (!STREET_PATTERN.test(street)) {
    errors.push("INVALID_STREET_FORMAT");
  }

  const city = address.city?.trim();
  if (!city) {
    errors.push("MISSING_CITY");
  } else if (city.length < 2) {
    errors.push("INVALID_CITY");
  }

  const state = address.state?.trim();
  if (!state) {
    errors.push("MISSING_STATE");
  } else if (!US_STATES.has(state.toUpperCase())) {
    errors.push("INVALID_STATE_CODE");
  }

  const zip = address.zip?.trim();
  if (!zip) {
    errors.push("MISSING_ZIP");
  } else if (!US_ZIP_REGEX.test(zip)) {
    errors.push("INVALID_ZIP_FORMAT");
  }

  // Check garbage patterns directly on pre-trimmed fields without allocating temporary arrays
  if (street) {
    for (let j = 0; j < GARBAGE_PATTERNS.length; j++) {
      if (GARBAGE_PATTERNS[j].test(street)) {
        errors.push("GARBAGE_ADDRESS_DATA");
        break;
      }
    }
  }

  if (city) {
    for (let j = 0; j < GARBAGE_PATTERNS.length; j++) {
      if (GARBAGE_PATTERNS[j].test(city)) {
        errors.push("GARBAGE_ADDRESS_DATA");
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
