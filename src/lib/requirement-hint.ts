/**
 * A suggestion for the lead's requirement, read from what the customer wrote and what the team
 * noted ("Need a cabin for 5 seats"). It only ever suggests: a person clicks to accept, so a wrong
 * guess never lands on a lead by itself. Returns null when neither a workspace type nor a seat
 * count can be read with confidence.
 */
export interface RequirementHint {
  workspace_type: "hot_desk" | "dedicated_desk" | "private_office" | "meeting_room" | "conference_room" | "virtual_office" | null;
  seat_capacity: number | null;
}

// Order matters: the more specific phrase wins ("dedicated desk" before a bare "desk").
const TYPE_PATTERNS: [RegExp, NonNullable<RequirementHint["workspace_type"]>][] = [
  [/\bvirtual office\b/i, "virtual_office"],
  [/\bconference room\b/i, "conference_room"],
  [/\bmeeting rooms?\b/i, "meeting_room"],
  [/\bhot[\s-]?desks?\b/i, "hot_desk"],
  [/\bdedicated[\s-]?desks?\b/i, "dedicated_desk"],
  [/\b(private\s+office|cabins?)\b/i, "private_office"],
];

// "5 seats", "5 seater", "for 5 people", "seats for 5"; capped so a phone number or a year is never a seat count.
const SEAT_PATTERNS: RegExp[] = [
  /\b(\d{1,3})\s*[- ]?(?:seats?|seater|people|persons|pax|members|employees|desks?)\b/i,
  /\bseats?\s+for\s+(\d{1,3})\b/i,
  /\bcabin\s+for\s+(\d{1,3})\b/i,
  /\bfor\s+(\d{1,3})\s+(?:of us|people|persons)\b/i,
];

export function suggestRequirement(texts: Array<string | null | undefined>): RequirementHint | null {
  const joined = texts.filter((t): t is string => !!t && t.trim().length > 0).join("\n");
  if (!joined) return null;

  let type: RequirementHint["workspace_type"] = null;
  for (const [re, t] of TYPE_PATTERNS) {
    if (re.test(joined)) {
      type = t;
      break;
    }
  }

  let seats: number | null = null;
  for (const re of SEAT_PATTERNS) {
    const m = joined.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 500) {
        seats = n;
        break;
      }
    }
  }

  return type || seats ? { workspace_type: type, seat_capacity: seats } : null;
}
