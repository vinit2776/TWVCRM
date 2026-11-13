// Virtual office KYC checks.
//
// These functions flag problems in the details a customer gives us (PAN, GSTIN,
// Aadhaar, CIN, names). They never certify a document legally: a passing check
// only means the format and check digits look right, not that the document is
// genuine or belongs to the person. A human reviewer makes the final call.
//
// Pure functions only: no database, no network, no logging of identity numbers.

import type { EntityType } from "@/types";

// ==========================================
// PAN
// ==========================================

export type PanHolderType = "P" | "C" | "F" | "H" | "A" | "T" | "B" | "L" | "J" | "G";

export const PAN_HOLDER_LABELS: Record<PanHolderType, string> = {
  P: "Individual",
  C: "Company",
  F: "Firm or LLP",
  H: "Hindu Undivided Family",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local authority",
  J: "Artificial juridical person",
  G: "Government",
};

export interface PanResult {
  valid: boolean;
  holderType: PanHolderType | null;
  issues: string[];
}

const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function compact(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function isPanHolderType(letter: string): letter is PanHolderType {
  return letter in PAN_HOLDER_LABELS;
}

export function validatePan(pan: string): PanResult {
  const value = compact(pan ?? "");
  const issues: string[] = [];
  if (!PAN_FORMAT.test(value)) {
    issues.push("PAN must be 5 letters, 4 digits and 1 letter, for example ABCDE1234F.");
    return { valid: false, holderType: null, issues };
  }
  const letter = value[3];
  if (!isPanHolderType(letter)) {
    issues.push("The 4th letter of this PAN is not a known holder type.");
    return { valid: false, holderType: null, issues };
  }
  return { valid: true, holderType: letter, issues };
}

const ENTITY_PAN_HOLDER: Partial<Record<EntityType, PanHolderType>> = {
  individual: "P",
  proprietorship: "P",
  partnership: "F",
  llp: "F",
  pvt_ltd: "C",
  public_ltd: "C",
  huf: "H",
  trust: "T",
};

// Entity types with no single expected holder type (society, other) accept any valid PAN.
export function panMatchesEntity(entityType: EntityType, pan: string): boolean {
  const result = validatePan(pan);
  if (!result.valid) return false;
  const expected = ENTITY_PAN_HOLDER[entityType];
  return expected === undefined || expected === result.holderType;
}

const NAME_TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "SHRI", "SMT", "SRI", "SHREE", "KUMARI"]);

function nameWords(fullName: string): string[] {
  return fullName
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NAME_TITLES.has(w));
}

// For a person PAN the 5th character is the first letter of the surname (taken as the last word).
export function panSurnameInitialMatches(pan: string, fullName: string): boolean {
  const result = validatePan(pan);
  if (!result.valid || result.holderType !== "P") return false;
  const words = nameWords(fullName ?? "");
  if (words.length === 0) return false;
  return words[words.length - 1][0] === compact(pan)[4];
}

// ==========================================
// GSTIN
// ==========================================

export interface GstinResult {
  valid: boolean;
  issues: string[];
}

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_ALPHABET.indexOf(first14[i]) * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

function isKnownStateCode(code: number): boolean {
  return (code >= 1 && code <= 38) || code === 97 || code === 99;
}

export function validateGstin(gstin: string): GstinResult {
  const value = compact(gstin ?? "");
  const issues: string[] = [];
  if (value.length !== 15 || !GSTIN_FORMAT.test(value)) {
    issues.push("GSTIN must be 15 characters in the standard GST format.");
    return { valid: false, issues };
  }
  if (!isKnownStateCode(Number(value.slice(0, 2)))) {
    issues.push("The first two digits of this GSTIN are not a valid state code.");
  }
  if (!validatePan(value.slice(2, 12)).valid) {
    issues.push("The PAN inside this GSTIN is not valid.");
  }
  if (gstinCheckChar(value.slice(0, 14)) !== value[14]) {
    issues.push("The last character of this GSTIN does not match, so it was probably mistyped.");
  }
  return { valid: issues.length === 0, issues };
}

export function panFromGstin(gstin: string): string | null {
  const value = compact(gstin ?? "");
  if (value.length !== 15) return null;
  const pan = value.slice(2, 12);
  return PAN_FORMAT.test(pan) ? pan : null;
}

export function gstinMatchesPan(gstin: string, pan: string): boolean {
  const embedded = panFromGstin(gstin);
  return embedded !== null && embedded === compact(pan ?? "");
}

// ==========================================
// Aadhaar
// ==========================================

export interface AadhaarResult {
  valid: boolean;
  issues: string[];
}

// Verhoeff tables (dihedral group D5 multiplication, permutation, inverse).
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffChecksum(digits: string): number {
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
  }
  return c;
}

function aadhaarDigits(input: string): string {
  return (input ?? "").replace(/\s+/g, "");
}

// Issues never repeat the number itself.
export function validateAadhaar(input: string): AadhaarResult {
  const digits = aadhaarDigits(input);
  const issues: string[] = [];
  if (!/^[0-9]{12}$/.test(digits)) {
    issues.push("Aadhaar must be exactly 12 digits.");
    return { valid: false, issues };
  }
  if (digits[0] === "0" || digits[0] === "1") {
    issues.push("Aadhaar numbers never start with 0 or 1.");
  }
  if (verhoeffChecksum(digits) !== 0) {
    issues.push("The last digit of this Aadhaar does not match, so it was probably mistyped.");
  }
  return { valid: issues.length === 0, issues };
}

export function maskAadhaar(input: string): string {
  const digits = aadhaarDigits(input);
  if (!/^[0-9]+$/.test(digits) || digits.length < 4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${digits.slice(-4)}`;
}

// ==========================================
// CIN and LLPIN
// ==========================================

export interface IdentifierResult {
  valid: boolean;
  issues: string[];
}

const CIN_FORMAT = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const LLPIN_FORMAT = /^[A-Z]{3}-[0-9]{4}$/;

export function validateCin(cin: string): IdentifierResult {
  const value = compact(cin ?? "");
  if (!CIN_FORMAT.test(value)) {
    return {
      valid: false,
      issues: ["CIN must be 21 characters, for example U74999MH2020PTC123456."],
    };
  }
  return { valid: true, issues: [] };
}

export function validateLlpin(llpin: string): IdentifierResult {
  const value = compact(llpin ?? "");
  if (!LLPIN_FORMAT.test(value)) {
    return { valid: false, issues: ["LLPIN must be 3 letters, a dash and 4 digits, for example AAB-1234."] };
  }
  return { valid: true, issues: [] };
}

// ==========================================
// Company names
// ==========================================

export const NAME_MATCH_THRESHOLD = 0.85;

const NAME_SUFFIXES = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP"]);
const NAME_VARIANTS: Record<string, string> = {
  TECHNOLOGIES: "TECHNOLOGY",
  SOLUTIONS: "SOLUTION",
  SERVICES: "SERVICE",
  SYSTEMS: "SYSTEM",
  ENTERPRISES: "ENTERPRISE",
  INDUSTRIES: "INDUSTRY",
  CO: "COMPANY",
  CORP: "CORPORATION",
  INTL: "INTERNATIONAL",
};

export function normalizeCompanyName(name: string): string {
  return (name ?? "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’.]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !NAME_SUFFIXES.has(w))
    .map((w) => NAME_VARIANTS[w] ?? w)
    .join(" ");
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = row;
  }
  return prev[b.length];
}

export interface NameMatch {
  score: number;
  match: boolean;
}

// Spaces are ignored so "Work Villa" and "WorkVilla" compare equal.
export function namesMatch(a: string, b: string): NameMatch {
  const left = normalizeCompanyName(a).replace(/ /g, "");
  const right = normalizeCompanyName(b).replace(/ /g, "");
  if (left.length === 0 || right.length === 0) return { score: 0, match: false };
  const longest = Math.max(left.length, right.length);
  const score = Math.round((1 - editDistance(left, right) / longest) * 1000) / 1000;
  return { score, match: score >= NAME_MATCH_THRESHOLD };
}

// ==========================================
// Automatic flags
// ==========================================

export type FlagSeverity = "ok" | "info" | "warning" | "serious";

export interface Flag {
  code: string;
  severity: FlagSeverity;
  field: string;
  message: string;
}

export interface KycFlagInput {
  entityType: EntityType;
  companyName: string;
  mcaName?: string;
  companyPan?: string;
  gstin?: string;
  signatoryName?: string;
  signatoryPan?: string;
  signatoryAadhaar?: string;
  cin?: string;
  /** ISO date, for example 2026-03-15. */
  certificateIssuedOn?: string;
  /** Defaults to the current date. Pass it to make checks repeatable. */
  today?: Date | string;
}

function flag(code: string, severity: FlagSeverity, field: string, message: string): Flag {
  return { code, severity, field, message };
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function companyPanFlags(input: KycFlagInput, pan: string): Flag[] {
  const result = validatePan(pan);
  if (!result.valid) {
    return [flag("company_pan_format", "serious", "companyPan", "The company PAN is not in a valid format.")];
  }
  const flags = [flag("company_pan_format", "ok", "companyPan", "Company PAN format looks right.")];
  if (panMatchesEntity(input.entityType, pan)) {
    flags.push(flag("company_pan_entity", "ok", "companyPan", "Company PAN type fits the business type."));
  } else {
    flags.push(
      flag("company_pan_entity", "serious", "companyPan", "The company PAN is the wrong type for this kind of business."),
    );
  }
  return flags;
}

function gstinFlags(gstin: string, companyPan: string | undefined): Flag[] {
  const result = validateGstin(gstin);
  if (!result.valid) {
    return [flag("gstin_invalid", "serious", "gstin", "The GSTIN failed its check, so it may be mistyped or fake.")];
  }
  const flags = [flag("gstin_invalid", "ok", "gstin", "GSTIN passes its format and check character.")];
  if (present(companyPan) && validatePan(companyPan).valid) {
    flags.push(
      gstinMatchesPan(gstin, companyPan)
        ? flag("gstin_pan_mismatch", "ok", "gstin", "The PAN inside the GSTIN matches the company PAN.")
        : flag("gstin_pan_mismatch", "serious", "gstin", "The PAN inside the GSTIN is different from the company PAN."),
    );
  }
  return flags;
}

function signatoryPanFlags(pan: string, name: string | undefined): Flag[] {
  const result = validatePan(pan);
  if (!result.valid) {
    return [flag("signatory_pan_format", "serious", "signatoryPan", "The signatory PAN is not in a valid format.")];
  }
  const flags = [flag("signatory_pan_format", "ok", "signatoryPan", "Signatory PAN format looks right.")];
  if (result.holderType !== "P") {
    flags.push(
      flag("signatory_pan_holder", "serious", "signatoryPan", "The signatory PAN belongs to an organisation, not a person."),
    );
    return flags;
  }
  flags.push(flag("signatory_pan_holder", "ok", "signatoryPan", "Signatory PAN belongs to a person."));
  if (present(name)) {
    flags.push(
      panSurnameInitialMatches(pan, name)
        ? flag("signatory_surname", "ok", "signatoryPan", "Signatory surname matches the PAN.")
        : flag("signatory_surname", "warning", "signatoryPan", "The signatory surname does not start with the letter shown in the PAN."),
    );
  }
  return flags;
}

function aadhaarFlags(aadhaar: string): Flag[] {
  const flags: Flag[] = [];
  flags.push(
    validateAadhaar(aadhaar).valid
      ? flag("aadhaar_check", "ok", "signatoryAadhaar", "Aadhaar number passes its check digit.")
      : flag("aadhaar_check", "warning", "signatoryAadhaar", "The Aadhaar number failed its check, so it may be mistyped."),
  );
  flags.push(
    flag("aadhaar_masked", "info", "signatoryAadhaar", `Aadhaar is stored masked, last 4 digits only (${maskAadhaar(aadhaar)}).`),
  );
  return flags;
}

function nameFlags(companyName: string, mcaName: string): Flag[] {
  return namesMatch(companyName, mcaName).match
    ? [flag("company_name_mca", "ok", "companyName", "Company name matches the MCA record.")]
    : [flag("company_name_mca", "warning", "companyName", "The company name is different from the MCA name.")];
}

function toDate(value: Date | string | undefined): Date | null {
  const date = value === undefined ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function certificateAgeFlags(issuedOn: string, todayInput: Date | string | undefined): Flag[] {
  const issued = toDate(issuedOn);
  const today = toDate(todayInput);
  if (!issued || !today) {
    return [flag("certificate_age", "info", "certificateIssuedOn", "The certificate date could not be read.")];
  }
  const cutoff = new Date(today.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return issued.getTime() < cutoff.getTime()
    ? [flag("certificate_age", "warning", "certificateIssuedOn", "The certificate is more than 12 months old.")]
    : [flag("certificate_age", "ok", "certificateIssuedOn", "The certificate is less than 12 months old.")];
}

function cinFlags(cin: string): Flag[] {
  return validateCin(cin).valid
    ? [flag("cin_format", "ok", "cin", "CIN format looks right.")]
    : [flag("cin_format", "warning", "cin", "The CIN is not in a valid format.")];
}

export function autoFlags(input: KycFlagInput): Flag[] {
  const flags: Flag[] = [];
  if (present(input.companyPan)) flags.push(...companyPanFlags(input, input.companyPan));
  if (present(input.gstin)) flags.push(...gstinFlags(input.gstin, input.companyPan));
  if (present(input.signatoryPan)) flags.push(...signatoryPanFlags(input.signatoryPan, input.signatoryName));
  if (present(input.signatoryAadhaar)) flags.push(...aadhaarFlags(input.signatoryAadhaar));
  if (present(input.cin)) flags.push(...cinFlags(input.cin));
  if (present(input.mcaName)) flags.push(...nameFlags(input.companyName, input.mcaName));
  if (present(input.certificateIssuedOn)) flags.push(...certificateAgeFlags(input.certificateIssuedOn, input.today));
  return flags;
}
