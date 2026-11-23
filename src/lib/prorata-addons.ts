import { addonLineForMonth, monthWindow, type AddonTerms } from "@/lib/addon-billing";

/**
 * The recurring add-ons' share of a renewal's partial first month, which the
 * first-month (pro-rata) invoice has to include: the invoice is the only bill for
 * those days, and add-ons are not part of the contract's subtotal. Each add-on is
 * prorated by day from the contract's start date to the end of that month.
 */
export interface ProrataAddonLine {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  amount: number;
  monthly_rate: number;
  days_used: number;
  days_in_month: number;
  period_start: string;
  period_end: string;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const round2 = (n: number) => Math.round(n * 100) / 100;

export function prorataAddonLines(addons: AddonTerms[], startDate: string): ProrataAddonLine[] {
  const month = monthWindow(startDate);
  const startDay = Number(startDate.slice(8, 10));
  const period = `${MONTH_NAMES[Number(startDate.slice(5, 7)) - 1]} ${startDay}\u2013${month.days}`;
  const lines: ProrataAddonLine[] = [];
  for (const addon of addons) {
    // Days before the contract starts are not this contract's to bill.
    const from = addon.effective_from > startDate ? addon.effective_from : startDate;
    const line = addonLineForMonth({ ...addon, effective_from: from }, month);
    if (!line) continue;
    lines.push({
      description: `Pro-Rata ${addon.description} (${period})`,
      quantity: 1,
      unit: "month",
      unit_price: line.amount,
      amount: line.amount,
      monthly_rate: addon.amount,
      days_used: Number(line.days_used ?? month.days),
      days_in_month: month.days,
      period_start: from,
      period_end: `${startDate.slice(0, 7)}-${String(month.days).padStart(2, "0")}`,
    });
  }
  return lines;
}

export function prorataAddonsTotal(lines: ProrataAddonLine[]): number {
  return round2(lines.reduce((sum, l) => sum + l.amount, 0));
}
