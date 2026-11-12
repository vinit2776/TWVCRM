import { WORKSPACE_TYPES, WORKSPACE_TYPE_LABELS } from "@/lib/constants";

/** What a public-form enquiry holds, as the contact-back form needs it. */
export interface ContactBackSource {
  payload: {
    name?: string;
    mobile?: string;
    company?: string;
    workspace_type?: string;
    seat_capacity?: string | number;
    budget_per_seat?: string | number;
    preferred_location?: string;
    start_date?: string;
  } | null;
  lead: {
    first_name?: string | null;
    last_name?: string | null;
    mobile?: string | null;
    email?: string | null;
    company?: string | null;
    workspace_type?: string | null;
    seat_capacity?: number | null;
    budget_per_seat?: number | null;
    location_id?: string | null;
  } | null;
}

export interface ContactBackPrefill {
  locationIds: string[];
  types: string[];
  seats: number;
  startDate: string;
  budget: string;
  phone: string;
  email: string;
  name: string;
  company: string;
}

/** One line per step, shown as "Form said: ...". Absent when the customer did not say. */
export interface ContactBackHints {
  location?: string;
  type?: string;
  seatsAndStart?: string;
  budget?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The centres a free-text location names. "Koramangala, Indiranagar" matches both. A name that
 *  matches none leaves the choice to the caller; the lead's own location is the fallback. */
export function matchLocationIds(
  text: string | null | undefined,
  locations: { id: string; name: string }[],
  fallbackId?: string | null,
): string[] {
  const wanted = norm(text ?? "");
  const hits = wanted
    ? locations.filter((l) => {
        const n = norm(l.name);
        return n && (wanted.includes(n) || n.includes(wanted));
      })
    : [];
  if (hits.length > 0) return hits.map((l) => l.id);
  return fallbackId && locations.some((l) => l.id === fallbackId) ? [fallbackId] : [];
}

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

const positiveNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function contactBackPrefill(
  src: ContactBackSource,
  locations: { id: string; name: string }[],
): ContactBackPrefill {
  const p = src.payload ?? {};
  const l = src.lead ?? {};
  const type = p.workspace_type ?? l.workspace_type ?? "";
  const budget = positiveNumber(p.budget_per_seat) ?? positiveNumber(l.budget_per_seat);
  const leadName = `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
  return {
    locationIds: matchLocationIds(p.preferred_location, locations, l.location_id),
    types: (WORKSPACE_TYPES as readonly string[]).includes(type) ? [type] : [],
    seats: positiveInt(p.seat_capacity) ?? l.seat_capacity ?? 1,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(p.start_date ?? "") ? (p.start_date as string) : "",
    budget: budget ? String(budget) : "",
    phone: l.mobile ?? p.mobile ?? "",
    email: l.email ?? "",
    name: leadName || p.name || "",
    company: l.company ?? p.company ?? "",
  };
}

export function contactBackHints(src: ContactBackSource): ContactBackHints {
  const p = src.payload ?? {};
  const hints: ContactBackHints = {};
  if (p.preferred_location?.trim()) hints.location = p.preferred_location.trim();
  if (p.workspace_type) hints.type = WORKSPACE_TYPE_LABELS[p.workspace_type] ?? p.workspace_type.replace(/_/g, " ");
  const seats = positiveInt(p.seat_capacity);
  const parts: string[] = [];
  if (seats) parts.push(`${seats} seat${seats === 1 ? "" : "s"}`);
  if (p.start_date?.trim()) parts.push(`start ${p.start_date.trim()}`);
  if (parts.length > 0) hints.seatsAndStart = parts.join(" · ");
  const budget = positiveNumber(p.budget_per_seat);
  if (budget) hints.budget = `budget ₹${budget.toLocaleString("en-IN")} per seat`;
  return hints;
}
