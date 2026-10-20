/**
 * Customer Value — the cost-to-serve simulator's maths
 * (docs/plans/customer-value-phase5-cost-simulator.md).
 *
 * Pure. It takes one customer's measured monthly figures ("base"), the
 * cost parameters an admin has entered, and an optional what-if (different seats
 * or rent per seat), and works out each cost line, the margins and the
 * break-even rent. Nothing is invented: a line with no input is "needs input"
 * and costs nothing, and the confidence figure says how much of the total cost
 * rests on measured data rather than a typed-in rate.
 *
 * All money is rupees per month, ex GST.
 */

export type CostGroup = "variable" | "fixed";
/** live: measured. part_live: a measured quantity times a rate someone entered. needs_input: not costed. */
export type CostStatus = "live" | "part_live" | "needs_input";

export type CostKey =
  | "electricity"
  | "concessions"
  | "staff_time"
  | "late_payment"
  | "pantry"
  | "acquisition"
  | "rent_share"
  | "housekeeping"
  | "maintenance"
  | "front_desk"
  | "internet"
  | "overhead";

export const COST_LABELS: Record<CostKey, string> = {
  electricity: "Electricity",
  concessions: "Concessions",
  staff_time: "Facility staff time",
  late_payment: "Cost of late payment",
  pantry: "Pantry and consumables",
  acquisition: "Acquisition cost",
  rent_share: "Rent share",
  housekeeping: "Housekeeping",
  maintenance: "Maintenance and AMC",
  front_desk: "Front desk and admin",
  internet: "Internet",
  overhead: "Head-office overhead",
};

const GROUPS: Record<CostKey, CostGroup> = {
  electricity: "variable", concessions: "variable", staff_time: "variable", late_payment: "variable", pantry: "variable", acquisition: "variable",
  rent_share: "fixed", housekeeping: "fixed", maintenance: "fixed", front_desk: "fixed", internet: "fixed", overhead: "fixed",
};

/** What was measured for this customer, as monthly averages over `months` completed months. Null = could not be measured. */
export interface SimBase {
  months: number;
  /** Seats on the customer's live contracts. */
  seats: number;
  /** Rent plus usage, ex GST. */
  revenue: number;
  /** Rent per seat per month on the contract; null when it cannot be told. */
  rentPerSeat: number | null;
  electricityCost: number | null;
  /** Counted concessions per month (giveaways, moratoriums, refunds, credit notes), spread over tenure. */
  concessions: number;
  staffMinutes: number | null;
  /** Invoice-value-weighted average days paid late, early counted as zero; null with nothing timed. */
  avgDaysLate: number | null;
  personDays: number | null;
  tenureMonths: number | null;
  /** The center's monthly lease and the seats it is split over; null without an active lease. */
  centerLease: number | null;
  centerSeats: number | null;
}

/** Rates and amounts an admin entered. Absent = not entered. */
export interface CostParams {
  hourlyStaffCost?: number;
  /** Annual cost of capital, percent. */
  costOfCapitalPct?: number;
  pantryPerPersonDay?: number;
  /** One-off commission or acquisition spend for this customer. */
  acquisitionCost?: number;
  housekeepingPerSeat?: number;
  maintenancePerSeat?: number;
  frontDeskPerSeat?: number;
  internetPerSeat?: number;
  /** Percent of revenue. */
  overheadPct?: number;
}

export interface WhatIf {
  seats?: number;
  rentPerSeat?: number;
}

export interface CostLine {
  key: CostKey;
  label: string;
  group: CostGroup;
  status: CostStatus;
  /** Rupees per month; 0 when needs_input. */
  amount: number;
  /** Why a needs_input line is not costed. */
  reason?: string;
}

export interface WhereItGoes {
  key: CostKey | "margin";
  label: string;
  amount: number;
}

export interface SimResult {
  seats: number;
  rentPerSeat: number | null;
  revenue: number;
  lines: CostLine[];
  variableCost: number;
  fixedCost: number;
  marginAfterVariable: number;
  fullyLoadedMargin: number;
  /** Margins as a share of revenue; null with no revenue. */
  marginAfterVariablePct: number | null;
  fullyLoadedPct: number | null;
  /** Rent per seat at which the margin is zero; null when not worked out or not reachable. */
  breakEvenAfterVariable: number | null;
  breakEvenFullyLoaded: number | null;
  /** Share of the costed total resting on measured data, 0 to 1; null with nothing costed. */
  confidence: number | null;
  missing: CostKey[];
  whereItGoes: WhereItGoes[];
}

const pos = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const round = (n: number) => Math.round(n);

function need(key: CostKey, reason: string): CostLine {
  return { key, label: COST_LABELS[key], group: GROUPS[key], status: "needs_input", amount: 0, reason };
}
function line(key: CostKey, status: Exclude<CostStatus, "needs_input">, amount: number): CostLine {
  return { key, label: COST_LABELS[key], group: GROUPS[key], status, amount };
}

/** Rupee cost of capital per rupee of invoice, from the average days paid late. */
export function lateFactor(avgDaysLate: number | null, costOfCapitalPct: number | undefined): number | null {
  if (avgDaysLate === null || !pos(costOfCapitalPct)) return null;
  return (costOfCapitalPct / 100) * (Math.max(0, avgDaysLate) / 365);
}

export function simulate(base: SimBase, params: CostParams, whatIf: WhatIf = {}): SimResult {
  const seats = pos(whatIf.seats) && whatIf.seats > 0 ? whatIf.seats : base.seats;
  const seatRatio = base.seats > 0 ? seats / base.seats : 1;

  // Rent can only be changed when the contract's rent per seat is known; usage and other revenue stay as they are.
  const baseRent = base.rentPerSeat !== null ? base.rentPerSeat * base.seats : null;
  const otherRevenue = baseRent !== null ? Math.max(0, base.revenue - baseRent) : base.revenue;
  const rentPerSeat = base.rentPerSeat === null ? null : pos(whatIf.rentPerSeat) ? whatIf.rentPerSeat : base.rentPerSeat;
  const revenue = rentPerSeat === null ? base.revenue * seatRatio : rentPerSeat * seats + otherRevenue;

  const lines: CostLine[] = [];

  // Electricity grows with seats: a seats split gives each seat the same kWh.
  lines.push(base.electricityCost === null ? need("electricity", "The center has no single linked meter, seat count or captured bill") : line("electricity", "live", base.electricityCost * seatRatio));

  // A concession is something already given; a what-if offer does not change it.
  lines.push(line("concessions", "live", base.concessions));

  if (base.staffMinutes === null) lines.push(need("staff_time", "No logged ticket time can be tied to this customer"));
  else if (!pos(params.hourlyStaffCost)) lines.push(need("staff_time", "No hourly staff cost entered"));
  else lines.push(line("staff_time", "part_live", (base.staffMinutes / 60) * params.hourlyStaffCost));

  const lf = lateFactor(base.avgDaysLate, params.costOfCapitalPct);
  if (base.avgDaysLate === null) lines.push(need("late_payment", "No invoice that fell due could be timed"));
  else if (lf === null) lines.push(need("late_payment", "No cost of capital entered"));
  else lines.push(line("late_payment", "part_live", revenue * lf));

  if (base.personDays === null) lines.push(need("pantry", "No door-access data to count person-days"));
  else if (!pos(params.pantryPerPersonDay)) lines.push(need("pantry", "No pantry cost per person-day entered"));
  else lines.push(line("pantry", "part_live", base.personDays * seatRatio * params.pantryPerPersonDay));

  if (!pos(params.acquisitionCost)) lines.push(need("acquisition", "No acquisition cost entered"));
  else if (base.tenureMonths === null || base.tenureMonths <= 0) lines.push(need("acquisition", "Tenure unknown, so it cannot be spread"));
  else lines.push(line("acquisition", "part_live", params.acquisitionCost / base.tenureMonths));

  if (base.centerLease === null || base.centerSeats === null || base.centerSeats <= 0) lines.push(need("rent_share", "No active lease or seat count for the center"));
  else lines.push(line("rent_share", "live", (base.centerLease / Math.max(base.centerSeats, seats)) * seats));

  const perSeat = (key: "housekeeping" | "maintenance" | "front_desk" | "internet", rate: number | undefined, what: string) =>
    lines.push(pos(rate) ? line(key, "part_live", rate * seats) : need(key, `No ${what} per seat entered`));
  perSeat("housekeeping", params.housekeepingPerSeat, "housekeeping cost");
  perSeat("maintenance", params.maintenancePerSeat, "maintenance cost");
  perSeat("front_desk", params.frontDeskPerSeat, "front desk cost");
  perSeat("internet", params.internetPerSeat, "internet cost");

  lines.push(pos(params.overheadPct) ? line("overhead", "part_live", (revenue * params.overheadPct) / 100) : need("overhead", "No overhead percentage entered"));

  const sum = (g: CostGroup) => lines.filter((l) => l.group === g && l.key !== "overhead").reduce((n, l) => n + l.amount, 0);
  const variableCost = sum("variable");
  const overhead = lines.find((l) => l.key === "overhead")?.amount ?? 0;
  const fixedCost = sum("fixed") + overhead;
  const marginAfterVariable = revenue - variableCost;
  const fullyLoadedMargin = marginAfterVariable - fixedCost;

  // Break-even: costs are A + b x revenue, where b is the cost that scales with the invoice (late payment, overhead).
  const bVariable = lf ?? 0;
  const bFull = bVariable + (pos(params.overheadPct) ? params.overheadPct / 100 : 0);
  const aVariable = variableCost - (lines.find((l) => l.key === "late_payment")?.amount ?? 0);
  const aFixedOnly = sum("fixed");
  const breakEven = (a: number, b: number): number | null => {
    if (rentPerSeat === null || seats <= 0 || b >= 1) return null;
    const rent = (a / (1 - b) - otherRevenue) / seats;
    return Math.max(0, round(rent));
  };

  const measured = lines.filter((l) => l.status === "live").reduce((n, l) => n + l.amount, 0);
  const costed = lines.reduce((n, l) => n + l.amount, 0);

  const whereItGoes: WhereItGoes[] = [
    ...lines.filter((l) => l.amount > 0).map((l) => ({ key: l.key, label: l.label, amount: round(l.amount) })),
    { key: "margin" as const, label: "Left over", amount: round(fullyLoadedMargin) },
  ];

  return {
    seats,
    rentPerSeat,
    revenue: round(revenue),
    lines: lines.map((l) => ({ ...l, amount: round(l.amount) })),
    variableCost: round(variableCost),
    fixedCost: round(fixedCost),
    marginAfterVariable: round(marginAfterVariable),
    fullyLoadedMargin: round(fullyLoadedMargin),
    marginAfterVariablePct: revenue > 0 ? marginAfterVariable / revenue : null,
    fullyLoadedPct: revenue > 0 ? fullyLoadedMargin / revenue : null,
    breakEvenAfterVariable: breakEven(aVariable, bVariable),
    breakEvenFullyLoaded: breakEven(aVariable + aFixedOnly, bFull),
    confidence: costed > 0 ? measured / costed : null,
    missing: lines.filter((l) => l.status === "needs_input").map((l) => l.key),
    whereItGoes,
  };
}
