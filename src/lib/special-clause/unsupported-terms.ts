// A plain-code backstop for the model review. The reviewer can miss a small
// commercial term that slips into an otherwise faithful draft (it once let
// "billed separately and paid within the time prescribed for membership fees"
// through when the author only said hours beyond 10 are charged). Payment,
// billing and timing words are exactly the terms a signed agreement turns on,
// so any fragment of the clause that uses one the author's request never used
// is treated as an addition, whatever the reviewer said.

const FAMILIES: [string, RegExp][] = [
  ["bill", /\bbill(?:s|ed|ing)?\b/i],
  ["invoice", /\binvoic\w*\b/i],
  ["pay", /\b(?:pay\w*|paid)\b/i],
  ["due", /\bdue\b/i],
  ["late", /\blate\b/i],
  ["interest", /\binterest\b/i],
  ["penalty", /\bpenalt\w*\b/i],
  ["deposit", /\bdeposit\w*\b/i],
  ["refund", /\brefund\w*\b/i],
  ["escalation", /\bescalat\w*\b/i],
  ["prescribed", /\bprescribed\b/i],
  ["deadline", /\bdeadline\w*\b/i],
  ["notice", /\bnotice\b/i],
  ["within", /\bwithin\b/i],
  ["advance", /\b(?:in advance|advance notice|prior)\b/i],
];

function families(text: string): Set<string> {
  const found = new Set<string>();
  for (const [name, re] of FAMILIES) if (re.test(text)) found.add(name);
  return found;
}

/** Fragments of `clause` that use a payment/billing/timing word absent from `request`. */
export function unsupportedTerms(clause: string, request: string): string[] {
  const allowed = families(request);
  const out: string[] = [];
  for (const sentence of clause.split(/(?<=[.;])\s+/)) {
    for (const fragment of sentence.split(/,\s*/)) {
      const bad = [...families(fragment)].filter((f) => !allowed.has(f));
      const cleaned = fragment.replace(/^[\s,;.]+|[\s,;.]+$/g, "");
      if (bad.length > 0 && cleaned.length > 0 && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out;
}
