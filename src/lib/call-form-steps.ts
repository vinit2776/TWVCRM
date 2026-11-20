export type Reached = "spoke" | "no_answer" | "whatsapp";

/** What the guided call form still needs before it can save, in the order the steps come. Empty means ready. */
export function stepsMissing(i: {
  real: "real" | "junk" | null;
  reached: Reached | null;
  hasLocation: boolean;
  hasType: boolean;
  contactOk: boolean;
  hasWhen: boolean;
  hasWhat: boolean;
}): string[] {
  if (i.real === null) return ["Is this a real enquiry?"];
  if (i.real === "junk") return [];
  const out: string[] = [];
  if (!i.reached) out.push("Did you reach them?");
  if (i.reached === "spoke") {
    if (!i.hasLocation) out.push("Which location");
    if (!i.hasType) out.push("What they want");
    if (!i.contactOk) out.push("A phone number or email");
  }
  if (i.reached) {
    if (!i.hasWhen) out.push("When to follow up");
    if (!i.hasWhat) out.push("What needs to happen");
  }
  return out;
}

/** The enquiry update each "did you reach them" answer is logged as when there was no real conversation. */
export const REACHED_UPDATE_KIND = { no_answer: "call_no_answer", whatsapp: "replied_whatsapp" } as const;
