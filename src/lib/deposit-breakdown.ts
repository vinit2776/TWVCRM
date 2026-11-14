import { DEPOSIT_TOPUP_CATEGORY_LABELS, type DepositTopupCategory } from "@/types";
import { depositShortfall } from "@/lib/deposit-requirement";
import { formatCurrency } from "@/lib/utils";

export interface BreakdownContract {
  id: string;
  contract_number: string;
  status: string;
  deposit_carried_from: string | null;
  deposit_payment_status: string | null;
  deposit_payment_amount: number | string | null;
  security_deposit_amount: number | string | null;
  deposit_refunded_amount: number | string | null;
}

export interface BreakdownLine {
  label: string;
  /** Signed: a deduction is negative. */
  amount: number;
  /** A contract's total or a pool total (bold), versus a component of it (indented). */
  kind: "total" | "component";
  note?: string;
}

export interface DepositBreakdown {
  /** What each live contract needs, split into the previous term and the change when it is a renewal. */
  required: BreakdownLine[];
  total_required: number;
  /** What the customer's pool holds and where it came from. */
  held: BreakdownLine[];
  available: number;
  shortfall: number;
  /** Held but not needed by any live contract: available for a future contract or a refund. */
  unallocated: number;
}

interface Input<C extends BreakdownContract> {
  contracts: C[];
  /** Contracts that no longer count (renewed, terminated). */
  excludedIds: Set<string>;
  requiredFor: (c: C) => number;
  paidTopups: { amount: number; category: string }[];
  /** Pool money already adjusted against other dues. */
  committed: number;
  /** The pool's own figure, so the breakdown can never disagree with the headline. */
  available: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The customer-readable working behind Required / Available / Shortfall:
 * every live contract's deposit (with a renewal split into the previous term
 * and the rate change), what the pool holds and where it came from, and what
 * is left to collect — or left over.
 */
export function buildDepositBreakdown<C extends BreakdownContract>(i: Input<C>): DepositBreakdown {
  const byId = new Map(i.contracts.map((c) => [c.id, c]));
  const required: BreakdownLine[] = [];
  let totalRequired = 0;

  for (const c of i.contracts) {
    if (i.excludedIds.has(c.id)) continue;
    const need = r2(i.requiredFor(c));
    totalRequired += need;
    required.push({ label: c.contract_number, amount: need, kind: "total" });
    const parent = c.deposit_carried_from ? byId.get(c.deposit_carried_from) : undefined;
    if (!parent) continue;
    const previous = r2(i.requiredFor(parent));
    if (previous <= 0 || previous === need) continue;
    const change = r2(need - previous);
    required.push({ label: `Previous term (${parent.contract_number})`, amount: previous, kind: "component" });
    required.push({
      label: change > 0 ? "Rate escalation on renewal" : "Rate reduction on renewal",
      amount: change,
      kind: "component",
    });
  }

  const held: BreakdownLine[] = [];
  for (const c of i.contracts) {
    if (c.deposit_payment_status !== "paid") continue;
    const paid = Number(c.deposit_payment_amount ?? c.security_deposit_amount ?? 0);
    const refunded = Number(c.deposit_refunded_amount || 0);
    const net = Math.max(paid - refunded, 0);
    if (net <= 0) continue;
    held.push({
      label: `Deposit paid — ${c.contract_number}`,
      amount: r2(net),
      kind: "component",
      note: refunded > 0 ? `${formatCurrency(paid)} less ${formatCurrency(refunded)} refunded` : undefined,
    });
  }
  const byCategory = new Map<string, number>();
  for (const t of i.paidTopups) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + Number(t.amount || 0));
  for (const [category, amount] of byCategory) {
    held.push({
      label: `Additional deposit — ${DEPOSIT_TOPUP_CATEGORY_LABELS[category as DepositTopupCategory] ?? category}`,
      amount: r2(amount),
      kind: "component",
    });
  }
  if (i.committed > 0) {
    held.push({ label: "Already applied to other dues", amount: -r2(i.committed), kind: "component" });
  }

  const available = r2(i.available);
  return {
    required,
    total_required: r2(totalRequired),
    held,
    available,
    shortfall: depositShortfall(totalRequired, available),
    unallocated: Math.max(r2(available - totalRequired), 0),
  };
}

/** Plain rows for a PDF or an email: label, signed amount text, whether it is a total. */
export function breakdownRows(b: DepositBreakdown): { label: string; value: string; bold: boolean; indent: boolean }[] {
  const money = (n: number) => (n < 0 ? `- ${formatCurrency(-n)}` : formatCurrency(n));
  const line = (l: BreakdownLine) => ({
    label: l.note ? `${l.label} (${l.note})` : l.label,
    value: money(l.amount),
    bold: l.kind === "total",
    indent: l.kind === "component",
  });
  const out = [{ label: "Deposit needed", value: "", bold: true, indent: false }];
  out.push(...b.required.map(line));
  out.push({ label: "Total deposit needed", value: money(b.total_required), bold: true, indent: false });
  out.push({ label: "Deposit we hold for you", value: "", bold: true, indent: false });
  out.push(...(b.held.length ? b.held.map(line) : [{ label: "Nothing received yet", value: money(0), bold: false, indent: true }]));
  out.push({ label: "Total held", value: money(b.available), bold: true, indent: false });
  out.push({
    label: b.shortfall > 0 ? "Balance to pay" : "Balance",
    value: money(b.shortfall),
    bold: true,
    indent: false,
  });
  if (b.unallocated > 0) {
    out.push({ label: "Held beyond what is needed (kept for future contracts or refund)", value: money(b.unallocated), bold: false, indent: true });
  }
  return out;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The same working as an email table, so the customer sees how the balance was arrived at. */
export function depositBreakdownHtml(b: DepositBreakdown): string {
  const rows = breakdownRows(b)
    .map((r) => {
      const style = r.bold
        ? "padding:7px 14px;font-weight:bold;color:#015E65;border-top:1px solid #d9e8e2;"
        : `padding:5px 14px 5px ${r.indent ? 28 : 14}px;color:#555;`;
      return `<tr><td style="${style}font-size:13px;">${esc(r.label)}</td><td style="${style}font-size:13px;text-align:right;white-space:nowrap;">${esc(r.value)}</td></tr>`;
    })
    .join("");
  return `<p style="color:#333;font-size:14px;margin:20px 0 6px;"><strong>How your security deposit is worked out</strong></p>
    <table style="border-collapse:collapse;width:100%;background:#f7fbf9;border-radius:6px;">${rows}</table>`;
}
