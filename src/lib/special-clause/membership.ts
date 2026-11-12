// Facts shared by the draft endpoint and the membership agreement PDF.

/** The membership agreement's fixed clauses run 1–36; the special clause is 37. */
export const MEMBERSHIP_SPECIAL_CLAUSE_NUMBER = 37;

/** Titles of the fixed clauses 20–36 plus the topics covered earlier in the agreement
 *  (kept as topics, not numbers, for the early clauses so a reorder can't mislead the reviewer). */
export const MEMBERSHIP_FIXED_CLAUSE_TOPICS = [
  "fees, payment and taxes",
  "security deposit",
  "use of premises and services",
  "lock-in and notice period",
  "representation and warranties",
  "force majeure",
  "indemnification",
  "termination by the Member",
  "termination or suspension by the Company",
  "removal from property upon termination",
  "confidentiality",
  "governing law and dispute resolution",
  "waiver of claims",
  "limitation of liability",
  "other members",
  "anti-corruption law",
  "other terms and conditions (entire agreement; amendments in writing)",
];

/** The agreement table already prints the clause number and title in their own
 *  columns, so drop the "37. Special Conditions." lead-in the AI draft starts with. */
export function stripClauseHeading(text: string, clauseNumber: number): string {
  const re = new RegExp(`^\\s*(?:clause\\s*)?${clauseNumber}\\s*[.):\\-–—]?\\s*special\\s+conditions?\\s*[.:\\-–—]?\\s*`, "i");
  return text.replace(re, "").trim();
}

/** Virtual-office documents print their own heading ("11. SPECIAL CONDITIONS" or
 *  "SPECIAL CONDITIONS:"), so strip whatever number/title lead-in the stored text has. */
export function stripSpecialConditionsHeading(text: string): string {
  return text
    .replace(/^\s*(?:clause\s*)?(?:\d+\s*[.):\-–—]?\s*)?special\s+conditions?\s*[.:\-–—]?\s*/i, "")
    .trim();
}

/** Topics covered by the virtual-office Leave & License agreement and proposal, for the conflict check. */
export const VIRTUAL_OFFICE_FIXED_CLAUSE_TOPICS = [
  "terms of usage of the address and services",
  "license fees and taxes",
  "service retainer / security deposit",
  "mail handling",
  "termination of service",
  "refund policy",
  "nature of business and permitted use",
  "liability",
  "confidentiality",
  "ownership (the licence gives no leasehold rights)",
  "required documents",
  "dispute resolution by arbitration at Chennai",
  "execution by electronic signature",
];
