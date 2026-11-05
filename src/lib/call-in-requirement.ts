import { WORKSPACE_TYPE_LABELS } from "@/lib/constants";

export interface CallInRequirement {
  /** Names of the centres they asked about, in the order the caller preferred them. */
  locations: string[];
  /** Workspace types they asked for. */
  types: string[];
  seats: number;
  /** yyyy-MM-dd, when they want to start. */
  startDate?: string | null;
  /** What we quoted them, per seat per month. */
  quotedPerSeat?: number | null;
  /** What they said they can spend, per seat per month. */
  budgetPerSeat?: number | null;
  requests?: string | null;
}

const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/**
 * The call, written out for the lead's history. A lead stores one location and one workspace type;
 * a caller can ask about several of each, so the full requirement is kept here, in words, where the
 * team reads it on the activity page.
 */
export function describeCallInRequirement(r: CallInRequirement): string {
  const lines: string[] = [];
  lines.push(`Looking at: ${r.locations.join(", ")}`);
  lines.push(`Wants: ${r.types.map((t) => WORKSPACE_TYPE_LABELS[t] ?? t).join(", ")} · ${r.seats} seat${r.seats === 1 ? "" : "s"}${r.startDate ? ` from ${r.startDate}` : ""}`);
  const price: string[] = [];
  if (r.quotedPerSeat) price.push(`Quoted ${money(r.quotedPerSeat)}/seat/month`);
  if (r.budgetPerSeat) price.push(`Budget ${money(r.budgetPerSeat)}/seat/month`);
  if (price.length > 0) lines.push(price.join(" · "));
  if (r.requests?.trim()) lines.push(`Other requests: ${r.requests.trim()}`);
  return lines.join("\n");
}

/** A lead needs a name. When the caller gave none, name it from how to reach them. */
export function callInLeadName(input: { name?: string | null; phone?: string | null; email?: string | null }): {
  first_name: string;
  last_name?: string;
} {
  const name = input.name?.trim();
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    return { first_name: first, last_name: rest.join(" ") || undefined };
  }
  return { first_name: "Caller", last_name: input.phone?.trim() || input.email?.trim() || undefined };
}
