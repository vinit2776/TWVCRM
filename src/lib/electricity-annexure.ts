/**
 * Calculation annexure for re-billed electricity.
 *
 * The customer is billed the month's total units, re-split to their agreed
 * utility/DG ratio, each at their own rate. The annexure prints that working
 * as a last page on the invoice. It deliberately carries no landlord rate and
 * no margin — only what the customer's own rates and units produce.
 *
 * The figures are frozen onto the statement's electricity line_items section
 * at dispatch time, so every later render (re-download, resend, Tally) prints
 * the same page without re-deriving anything from a bill that may be revised.
 */

import { computeGstAndRounding } from "@/lib/gst-math";

export interface ElectricityAnnexureLine {
  label: string;
  units: number;
  rate: number;
  amount: number;
}

export interface ElectricityAnnexure {
  monthLabel: string;
  totalUnits: number;
  /** Customer's agreed split, e.g. 80 / 20 — printed in the heading only. */
  utilityPct: number;
  generatorPct: number;
  lines: ElectricityAnnexureLine[];
  subtotal: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  roundOff: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ElectricityAnnexureBill {
  customer_units_billed: number | string | null;
  customer_utility_pct: number | string | null;
  customer_generator_pct: number | string | null;
  customer_utility_rate: number | string | null;
  customer_generator_rate: number | string | null;
  customer_subtotal: number | string | null;
  gst_rate: number | string | null;
}

/** Same unit split and per-line maths the dispatch route and the preview use for the invoice lines. */
export function buildElectricityAnnexure(bill: ElectricityAnnexureBill, monthLabel: string): ElectricityAnnexure {
  const totalUnits = Number(bill.customer_units_billed ?? 0);
  const utilityPct = Number(bill.customer_utility_pct ?? 0);
  const generatorPct = Number(bill.customer_generator_pct ?? 0);
  const lines: ElectricityAnnexureLine[] = [];

  const utilityUnits = round2((totalUnits * utilityPct) / 100);
  if (utilityUnits > 0) {
    const rate = Number(bill.customer_utility_rate ?? 0);
    lines.push({ label: "Utility / grid", units: utilityUnits, rate, amount: round2(utilityUnits * rate) });
  }
  const generatorUnits = round2((totalUnits * generatorPct) / 100);
  if (generatorUnits > 0) {
    const rate = Number(bill.customer_generator_rate ?? 0);
    lines.push({ label: "DG / generator", units: generatorUnits, rate, amount: round2(generatorUnits * rate) });
  }

  // Totals come from the same function that totals the invoice itself, so the
  // annexure can never disagree with the page in front of it.
  const subtotal = Number(bill.customer_subtotal ?? 0);
  const gstRate = Number(bill.gst_rate ?? 18);
  const gst = computeGstAndRounding(subtotal, gstRate);

  return {
    monthLabel,
    totalUnits,
    utilityPct,
    generatorPct,
    lines,
    subtotal,
    gstRate,
    cgst: gst.cgst,
    sgst: gst.sgst,
    roundOff: gst.roundOff,
    total: gst.totalAmount,
  };
}

function isAnnexure(v: unknown): v is ElectricityAnnexure {
  const a = v as ElectricityAnnexure | null;
  return !!a && typeof a === "object" && Array.isArray(a.lines) && a.lines.length > 0 && typeof a.totalUnits === "number";
}

/** Pulls the frozen annexure off a statement's line_items sections, if it has one. */
export function annexureFromSections(sections: unknown): ElectricityAnnexure | undefined {
  if (!Array.isArray(sections)) return undefined;
  for (const sec of sections as Array<{ type?: string; annexure?: unknown }>) {
    if (sec?.type === "electricity" && isAnnexure(sec.annexure)) return sec.annexure;
  }
  return undefined;
}
