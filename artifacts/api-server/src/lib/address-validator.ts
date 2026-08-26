const US_STATES: Set<string> = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
]);

const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;
const STREET_PATTERN = /\d+\s+\S+/;

// PERF: Combined garbage regex hoisted to module level eliminates 6 RegExp allocations
// and nested loop iterations per validation call. Case-insensitive character classes
// bypass expensive regex flag switching and multiple `.test()` executions.
const GARBAGE_ADDRESS_RE = /^(?:[xX]+|0+|[tT][eE][sS][tT]|[aA][sS][dD][fF]|[nN][aA]|[nN][oO][nN][eE])$/;

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

  // PERF: Trim each field string once and cache in local variables to avoid
  // redundant `.trim()` calls and intermediate string allocations across validation rules.
  const street = address.street_address ? address.street_address.trim() : "";
  if (!street) {
    errors.push("MISSING_STREET");
  } else if (!STREET_PATTERN.test(street)) {
    errors.push("INVALID_STREET_FORMAT");
  }

  const city = address.city ? address.city.trim() : "";
  if (!city) {
    errors.push("MISSING_CITY");
  } else if (city.length < 2) {
    errors.push("INVALID_CITY");
  }

  const state = address.state ? address.state.trim() : "";
  if (!state) {
    errors.push("MISSING_STATE");
  } else if (!US_STATES.has(state.toUpperCase())) {
    errors.push("INVALID_STATE_CODE");
  }

  const zip = address.zip ? address.zip.trim() : "";
  if (!zip) {
    errors.push("MISSING_ZIP");
  } else if (!US_ZIP_REGEX.test(zip)) {
    errors.push("INVALID_ZIP_FORMAT");
  }

  // PERF: Avoid creating intermediate `fieldsToCheck` array and calling `.trim()`
  // repeatedly inside nested loops by testing pre-trimmed street/city strings against
  // single consolidated GARBAGE_ADDRESS_RE regex.
  if ((street && GARBAGE_ADDRESS_RE.test(street)) || (city && GARBAGE_ADDRESS_RE.test(city))) {
    errors.push("GARBAGE_ADDRESS_DATA");
  }

  return { valid: errors.length === 0, errors };
}
