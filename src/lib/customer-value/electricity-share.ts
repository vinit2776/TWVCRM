/**
 * Customer Value — one customer's share of a center's electricity
 * (docs/plans/customer-value-phase4-electricity.md).
 *
 * Seats method: for a month, his kWh = the center's kWh x (his seats / the
 * seats the center is split over). Seats nobody has contracted are a Vacant
 * line: the center's cost, not any customer's. Cost = kWh x the month's blended
 * tariff from the captured landlord bill; a month with no bill has kWh and no
 * rupees, never an invented figure. Cost recovery = attributed cost minus
 * electricity billed to him.
 *
 * Pure: the route loads the facts. A missing input is null and stays null: an
 * unknown month is a gap, never zero.
 */

export interface ElectricityMonthInput {
  /** YYYY-MM */
  month: string;
  /** Center kWh from the meter; null when the month's readings are missing. */
  centerKwh: number | null;
  /** The current month, still accumulating. */
  partial: boolean;
  /** Days in the month with no usable reading. */
  unknownDays: number;
  /** His seats that month (seat-days weighted); null or 0 when he had none. */
  seats: number | null;
  /** Seats of all the center's customers that month, including his. */
  contractedSeats: number;
  /** Rupees per kWh from that month's bill; null with no bill. */
  tariff: number | null;
  /** Electricity billed to him that month, before GST; null when none was billed. */
  billed: number | null;
}

export interface ElectricityMonth {
  month: string;
  partial: boolean;
  unknownDays: number;
  seats: number;
  /** His share of the center's seat split, 0 to 1. */
  share: number | null;
  centerKwh: number | null;
  kwh: number | null;
  othersKwh: number | null;
  vacantKwh: number | null;
  tariff: number | null;
  cost: number | null;
  billed: number | null;
  /** Cost minus billed; positive = out of pocket. Null unless both are known. */
  shortfall: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = (n: number) => Math.round(n);

/**
 * The seats the center's kWh is split over: the center's capacity, or the
 * contracted seats if they exceed it (over-contracted), so no share passes 100%.
 */
export function splitBase(capacity: number, contractedSeats: number): number {
  return Math.max(capacity, contractedSeats);
}

export function electricityMonth(input: ElectricityMonthInput, capacity: number): ElectricityMonth {
  const seats = input.seats ?? 0;
  const base = splitBase(capacity, input.contractedSeats);
  const share = seats > 0 && base > 0 ? seats / base : null;
  const known = input.centerKwh !== null && share !== null;
  const kwh = known ? (input.centerKwh as number) * (share as number) : null;
  const othersKwh = known ? (input.centerKwh as number) * ((input.contractedSeats - seats) / base) : null;
  const vacantKwh = known ? (input.centerKwh as number) * (Math.max(0, base - input.contractedSeats) / base) : null;
  const cost = kwh !== null && input.tariff !== null ? kwh * input.tariff : null;
  return {
    month: input.month,
    partial: input.partial,
    unknownDays: input.unknownDays,
    seats,
    share,
    centerKwh: input.centerKwh,
    kwh: kwh === null ? null : r1(kwh),
    othersKwh: othersKwh === null ? null : r1(Math.max(0, othersKwh)),
    vacantKwh: vacantKwh === null ? null : r1(vacantKwh),
    tariff: input.tariff,
    cost: cost === null ? null : r0(cost),
    billed: input.billed === null ? null : r0(input.billed),
    // Nothing billed is a known zero, not a gap: he paid nothing toward a cost we can see.
    shortfall: cost !== null ? r0(cost - (input.billed ?? 0)) : null,
  };
}

export interface ElectricitySummary {
  /** Completed months the figures cover. */
  months: number;
  kwh: number;
  cost: number;
  billed: number;
  shortfall: number;
  /** Average share over those months, 0 to 1. */
  share: number | null;
  /** Months with kWh but no bill, so no cost. */
  monthsWithoutBill: number;
}

/**
 * Totals over the completed months that have a figure. A month with kWh and a
 * tariff counts toward cost and recovery; billed counts as zero for such a month
 * when nothing was billed (he paid nothing for electricity that month).
 */
export function summarise(months: ElectricityMonth[]): ElectricitySummary | null {
  const done = months.filter((m) => !m.partial && m.kwh !== null);
  if (done.length === 0) return null;
  const costed = done.filter((m) => m.cost !== null);
  const shares = done.flatMap((m) => (m.share === null ? [] : [m.share]));
  const cost = costed.reduce((n, m) => n + (m.cost as number), 0);
  const billed = costed.reduce((n, m) => n + (m.billed ?? 0), 0);
  return {
    months: done.length,
    kwh: r1(done.reduce((n, m) => n + (m.kwh as number), 0)),
    cost: r0(cost),
    billed: r0(billed),
    shortfall: r0(cost - billed),
    share: shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : null,
    monthsWithoutBill: done.length - costed.length,
  };
}

export interface BillForTariff {
  landlord_total_amount: number | string | null;
  lines: Array<{ line_type: string; units: number | string | null }>;
}

/** Rupees per unit for a month: bill total over utility and generator units; null when it cannot be worked out. */
export function blendedTariff(bills: BillForTariff[]): number | null {
  let total = 0;
  let units = 0;
  for (const b of bills) {
    const t = Number(b.landlord_total_amount);
    const u = b.lines.reduce((n, l) => (l.line_type === "utility" || l.line_type === "generator") && l.units !== null ? n + Number(l.units) : n, 0);
    if (!(t > 0) || !(u > 0)) continue;
    total += t;
    units += u;
  }
  return units > 0 ? total / units : null;
}
