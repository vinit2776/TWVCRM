export interface StatementPurchase {
  packageName: string;
  creditType: "hours" | "days" | "bookings";
  totalCredits: number;
  creditsUsed: number;
  pricePaid: number;
  purchasedAt: string;
  expiresAt: string;
  cancellationWindowHours: number | null;
  locations: string[];
}

export interface StatementRedemption {
  bookingId: string;
  bookingNumber: string;
  redeemedAt: string;
  creditsDeducted: number;
  locationName: string | null;
}

export interface StatementCancellation {
  bookingId: string;
  createdAt: string;
  trigger: "cancel" | "no_show";
  outcome: "restored" | "forfeited";
  creditsRestored: number;
  hoursBeforeStart: number;
  windowHours: number | null;
  isOverride: boolean;
  overrideReason: string | null;
}

export type StatementTag = "restored" | "forfeited" | "override";

export interface StatementRow {
  date: string;
  entry: string;
  detail: string;
  tag?: StatementTag;
  /** Signed change to the balance, in credit units. */
  change: number;
  balance: number;
}

export interface PackageStatement {
  rows: StatementRow[];
  /** Balance the ledger adds up to. */
  balance: number;
  unitLabel: string;
}

const UNIT_LABELS = { hours: "hrs", days: "days", bookings: "bookings" } as const;

const n = (v: number) => String(Math.round(v * 100) / 100);
const hrs = (v: number) => `${n(v)} ${n(v) === "1" ? "hr" : "hrs"}`;

function describeCancellation(c: StatementCancellation): string {
  const when = `Cancelled ${hrs(c.hoursBeforeStart)} before start`;
  const rule = c.windowHours === null
    ? "this package does not restore credits on cancellation"
    : `free cancellation up to ${hrs(c.windowHours)}`;
  if (c.isOverride) {
    const base = c.trigger === "no_show" ? "No-show" : `${when}, ${rule}`;
    return `${base}. ${c.outcome === "restored" ? "Restored" : "Not restored"} by manager override: ${c.overrideReason ?? "no reason recorded"}.`;
  }
  if (c.trigger === "no_show") return "Customer did not attend. Not restored.";
  return `${when}, ${rule}. ${c.outcome === "restored" ? "Restored." : "Not restored."}`;
}

/**
 * Turn what was recorded against a package into a ledger with a running
 * balance. Anything the records do not explain (a manual correction made
 * outside the app) is shown as its own adjustment row, never hidden.
 */
export function buildPackageStatement(
  purchase: StatementPurchase,
  redemptions: StatementRedemption[],
  cancellations: StatementCancellation[],
): PackageStatement {
  const bookingNumbers = new Map(redemptions.map((r) => [r.bookingId, r.bookingNumber]));
  const unit = UNIT_LABELS[purchase.creditType];

  type Entry = Omit<StatementRow, "balance"> & { order: number; sortKey: string };
  const entries: Entry[] = [
    {
      date: purchase.purchasedAt,
      sortKey: purchase.purchasedAt,
      order: 0,
      entry: "Package purchased",
      detail: `${n(purchase.totalCredits)} ${unit}, paid Rs. ${n(purchase.pricePaid)}`,
      change: purchase.totalCredits,
    },
    ...redemptions.map((r): Entry => ({
      date: r.redeemedAt,
      sortKey: r.redeemedAt,
      order: 1,
      entry: `${r.bookingNumber}${r.locationName ? ` - ${r.locationName}` : ""}`,
      detail: `Used ${n(r.creditsDeducted)} ${purchase.creditType === "hours" ? (n(r.creditsDeducted) === "1" ? "hr" : "hrs") : unit}`,
      change: -r.creditsDeducted,
    })),
    ...cancellations.map((c): Entry => ({
      date: c.createdAt,
      sortKey: c.createdAt,
      order: 2,
      entry: `${bookingNumbers.get(c.bookingId) ?? "Booking"} ${c.trigger === "no_show" ? "no-show" : "cancelled"}`,
      detail: describeCancellation(c),
      tag: c.isOverride ? "override" : c.outcome,
      change: c.outcome === "restored" ? c.creditsRestored : 0,
    })),
  ];

  entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.order - b.order);

  const explained = entries.reduce((s, e) => s + e.change, 0);
  const recorded = Math.round((purchase.totalCredits - purchase.creditsUsed) * 100) / 100;
  const gap = Math.round((recorded - explained) * 100) / 100;
  if (gap !== 0) {
    entries.push({
      date: entries[entries.length - 1].date,
      sortKey: "~",
      order: 3,
      entry: "Adjustment",
      detail: "Balance corrected outside the booking records",
      change: gap,
    });
  }

  let running = 0;
  const rows = entries.map(({ order: _o, sortKey: _s, ...e }) => {
    running = Math.round((running + e.change) * 100) / 100;
    return { ...e, balance: running };
  });

  return { rows, balance: running, unitLabel: unit };
}
