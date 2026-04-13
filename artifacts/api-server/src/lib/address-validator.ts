const US_STATES: Set<string> = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
]);

const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;
const STREET_PATTERN = /\d+\s+\S+/;

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

  if (!address.street_address?.trim()) {
    errors.push("MISSING_STREET");
  } else if (!STREET_PATTERN.test(address.street_address.trim())) {
    errors.push("INVALID_STREET_FORMAT");
  }

  if (!address.city?.trim()) {
    errors.push("MISSING_CITY");
  } else if (address.city.trim().length < 2) {
    errors.push("INVALID_CITY");
  }

  if (!address.state?.trim()) {
    errors.push("MISSING_STATE");
  } else if (!US_STATES.has(address.state.trim().toUpperCase())) {
    errors.push("INVALID_STATE_CODE");
  }

  if (!address.zip?.trim()) {
    errors.push("MISSING_ZIP");
  } else if (!US_ZIP_REGEX.test(address.zip.trim())) {
    errors.push("INVALID_ZIP_FORMAT");
  }

  const garbagePatterns = [/^[x]+$/i, /^[0]+$/, /^test$/i, /^asdf$/i, /^na$/i, /^none$/i];
  const fieldsToCheck = [address.street_address, address.city];
  for (const field of fieldsToCheck) {
    if (field) {
      for (const pat of garbagePatterns) {
        if (pat.test(field.trim())) {
          errors.push("GARBAGE_ADDRESS_DATA");
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
