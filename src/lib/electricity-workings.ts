import type { SupabaseClient } from "@supabase/supabase-js";
import { formatRs } from "@/lib/booking-usage-line";

export interface LandlordLine {
  line_type: "utility" | "generator" | "other";
  units: number | null;
  amount: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const units = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Landlord's weighted-average rate and units for one line type, as the approve step computed them. */
function landlordSide(lines: LandlordLine[], type: "utility" | "generator") {
  const own = lines.filter((l) => l.line_type === type);
  const u = own.reduce((s, l) => s + Number(l.units ?? 0), 0);
  const amount = own.reduce((s, l) => s + Number(l.amount ?? 0), 0);
  return { units: u, rate: u > 0 ? amount / u : 0 };
}

/**
 * The "how we got this" text printed under each electricity line on the customer invoice:
 * landlord units -> our re-split -> landlord rate + margin = rate charged.
 * Returns undefined when the landlord lines are unavailable, so the invoice prints as before.
 */
export function electricityWorkings(p: {
  landlordLines: LandlordLine[];
  type: "utility" | "generator";
  customerPct: number;
  customerUnits: number;
  customerRate: number;
  showLandlordRate: boolean;
}): string | undefined {
  const util = landlordSide(p.landlordLines, "utility");
  const gen = landlordSide(p.landlordLines, "generator");
  const totalUnits = util.units + gen.units;
  if (totalUnits <= 0) return undefined;

  const split =
    `Landlord billed ${units(totalUnits)} units (Utility ${units(util.units)} + DG ${units(gen.units)}); ` +
    `${p.customerPct}% = ${units(p.customerUnits)} units.`;
  if (!p.showLandlordRate) return split;

  const cost = p.type === "utility" ? util.rate : gen.rate;
  const margin = round2(p.customerRate - cost);
  return `${split} Landlord rate ${formatRs(round2(cost))} + margin ${formatRs(margin)} = ${formatRs(p.customerRate)} per unit.`;
}

/** The landlord bill's charge lines behind a customer bill, or [] if it has none or the read fails. */
export async function loadLandlordLines(supabase: SupabaseClient, landlordBillId: string | null): Promise<LandlordLine[]> {
  if (!landlordBillId) return [];
  const { data, error } = await supabase
    .from("electricity_bill_lines")
    .select("line_type, units, amount")
    .eq("electricity_bill_id", landlordBillId);
  if (error) {
    console.error("[eb] landlord lines read failed:", error.message);
    return [];
  }
  return (data ?? []) as LandlordLine[];
}

/** Whether the invoice also prints the landlord's rate and our margin. */
export const SHOW_LANDLORD_RATE_ON_INVOICE = false;
