/**
 * Pure rules for the exit settlement: what clearing is allowed, how the deposit
 * splits between refund / retained charges / owed, and bank detail checks.
 */

export const SETTLEMENT_STATUSES = ["pending_approval", "returned", "approved", "paid", "closed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  pending_approval: "Awaiting admin approval",
  returned: "Returned for changes",
  approved: "Approved, to pay",
  paid: "Paid",
  closed: "Closed",
};

/** Staff who may send a settlement for approval. */
export const SETTLEMENT_CLEAR_ROLES = ["admin", "manager", "sales_rep"] as const;
/** The only role that approves or returns. */
export const SETTLEMENT_APPROVE_ROLES = ["admin"] as const;
/** Who records the manual bank payment. */
export const SETTLEMENT_PAY_ROLES = ["admin", "accounts"] as const;
/** Who can see the list and review pages. */
export const SETTLEMENT_VIEW_ROLES = ["admin", "manager", "sales_rep", "accounts", "floor_manager"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Clearance {
  outcome: "refund" | "owed" | "nil";
  retained: number;
  refund: number;
  owed: number;
}

/** Split the deposit the exit may settle across the charges: charges first, remainder refunded. */
export function computeClearance(depositAvailable: number, charges: number): Clearance {
  const deposit = Math.max(0, round2(depositAvailable));
  const total = Math.max(0, round2(charges));
  const retained = round2(Math.min(deposit, total));
  const refund = round2(deposit - retained);
  const owed = round2(total - retained);
  return { outcome: refund > 0 ? "refund" : owed > 0 ? "owed" : "nil", retained, refund, owed };
}

export interface ClearanceFacts {
  exitStatus: string;
  inspectionDone: boolean;
  unpaidInvoices: number;
  unbilledUsage: number;
  hasLiveSettlement: boolean;
}

/** Reasons clearing is refused. Empty means it may go ahead. */
export function clearanceBlockers(f: ClearanceFacts): string[] {
  const out: string[] = [];
  if (f.hasLiveSettlement) out.push("This exit has already been sent for approval.");
  if (f.exitStatus !== "completed") out.push("Complete the exit first (access removed on the last day).");
  if (!f.inspectionDone) out.push("Mark the inspection done.");
  if (f.unpaidInvoices > 0) out.push("Settle the customer's unpaid invoices first (record a payment or a deposit adjustment in Billing).");
  if (f.unbilledUsage > 0) out.push("Invoice the unbilled usage first (Billing, Unbilled).");
  return out;
}

export interface BankDetails { bank_account_name: string; bank_account_number: string; bank_ifsc: string }

export function validateBankDetails(b: Partial<BankDetails>): string | null {
  if (!b.bank_account_name?.trim()) return "Enter the account holder's name.";
  if (!/^\d{6,20}$/.test((b.bank_account_number ?? "").trim())) return "Enter a valid account number (digits only).";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test((b.bank_ifsc ?? "").trim().toUpperCase())) return "Enter a valid IFSC code.";
  return null;
}

/** Last four digits only, for lists and notices. */
export function maskAccount(n: string | null | undefined): string {
  const s = (n ?? "").replace(/\s/g, "");
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}
