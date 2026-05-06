/**
 * Place-of-supply helpers + Indian state code dictionary.
 *
 * The first two characters of a GSTIN are the state code (per the
 * MoF/GSTN master list). For services, place of supply for a B2B
 * registered recipient = recipient's location (i.e., recipient's state).
 *
 * Intrastate → CGST + SGST (each at half the GST rate).
 * Interstate → IGST at full rate.
 */

/** Canonical Indian state code list (per CBIC master). */
export const INDIAN_STATE_CODES: Record<string, string> = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (Old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh (New)",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Other Country",
};

/** Returns the state name for a 2-digit state code. */
export function stateNameFromCode(code: string): string {
  return INDIAN_STATE_CODES[code] ?? `Unknown (${code})`;
}

/** Extract the 2-digit state code from the first 2 chars of a GSTIN. */
export function stateCodeFromGstin(gstin: string): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return INDIAN_STATE_CODES[code] ? code : null;
}

/** True if buyer & seller are in the same state (intrastate). */
export function isIntrastate(sellerStateCode: string, buyerOrPosStateCode: string): boolean {
  return sellerStateCode === buyerOrPosStateCode;
}

/** Validate GSTIN with checksum (modulus 36 algorithm). */
export function isValidGstin(gstin: string): boolean {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  // Checksum verification (GSTN's mod-36 algorithm)
  const factor = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = charset.indexOf(gstin[i]) * factor[i];
    sum += Math.floor(v / 36) + (v % 36);
  }
  const checkChar = charset[(36 - (sum % 36)) % 36];
  return checkChar === gstin[14];
}
