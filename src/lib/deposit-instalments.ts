/**
 * Staged security deposit: the required deposit stays ONE obligation on the
 * proposal; each "ask" is a row in proposal_deposit_instalments (migration
 * 00649). The proposal's completed-deposit fields are written only when the
 * parts paid reach the required amount (see _rollup_proposal_deposit), so the
 * activation gate and everything else that reads "paid" is unchanged.
 *
 * This module is the pure half: the figures shown to staff and customers, the
 * roles, and the wording for the database function's refusal codes. The money
 * rules themselves are enforced in the RPCs; the checks here only exist so the
 * UI can say the same thing before a round trip.
 */

export const DEPOSIT_INSTALMENT_REQUEST_ROLES = ["admin", "manager", "sales_rep"] as const;
/** May approve a first part below the minimum slice (and carry a reason). */
export const DEPOSIT_INSTALMENT_OVERRIDE_ROLES = ["admin", "manager"] as const;

export function canRequestDepositInstalment(role: string | null | undefined): boolean {
  return !!role && (DEPOSIT_INSTALMENT_REQUEST_ROLES as readonly string[]).includes(role);
}

export function canOverrideDepositFloor(role: string | null | undefined): boolean {
  return !!role && (DEPOSIT_INSTALMENT_OVERRIDE_ROLES as readonly string[]).includes(role);
}

export const DEPOSIT_INSTALMENT_STATUSES = ["requested", "paid", "cancelled"] as const;
export type DepositInstalmentStatus = (typeof DEPOSIT_INSTALMENT_STATUSES)[number];

export const DEPOSIT_INSTALMENT_STATUS_LABELS: Record<DepositInstalmentStatus, string> = {
  requested: "Link sent",
  paid: "Paid",
  cancelled: "Cancelled",
};

export const DEPOSIT_INSTALMENT_STATUS_COLORS: Record<DepositInstalmentStatus, string> = {
  requested: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  cancelled: "bg-gray-100 text-gray-600",
};

export const DEFAULT_MIN_FIRST_PART_PERCENT = 25;

export interface InstalmentFigures {
  amount: number | string;
  status: DepositInstalmentStatus | string;
  paid_amount?: number | string | null;
}

export interface DepositProposalFigures {
  security_deposit_amount?: number | string | null;
  deposit_exception_amount?: number | string | null;
  deposit_credit_amount?: number | string | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The net deposit the customer owes: deposit + exception − credit (never negative). */
export function requiredDeposit(p: DepositProposalFigures): number {
  return Math.max(0, round2(num(p.security_deposit_amount) + num(p.deposit_exception_amount) - num(p.deposit_credit_amount)));
}

export interface DepositPosition {
  /** Net deposit owed. */
  required: number;
  /** Everything asked for and not cancelled — paid or still awaiting. */
  requested: number;
  /** Money actually received. */
  paid: number;
  /** Asked for, link out, not yet paid. */
  awaiting: number;
  /** Required − requested: not yet asked for. */
  notYetAsked: number;
  /** Required − paid: what is still to collect. */
  balance: number;
  partsPaid: number;
}

/**
 * The five figures shown on the proposal and in every message:
 *   required − paid = balance;  requested − paid = awaiting;
 *   required − requested = not yet asked.
 */
export function depositPosition(required: number, rows: InstalmentFigures[]): DepositPosition {
  const live = rows.filter((r) => r.status !== "cancelled" || num(r.paid_amount) > 0);
  const paidRows = live.filter((r) => r.status === "paid");
  const paid = round2(paidRows.reduce((s, r) => s + num(r.paid_amount), 0));
  const awaiting = round2(live.filter((r) => r.status === "requested").reduce((s, r) => s + num(r.amount), 0));
  const requested = round2(paid + awaiting);
  return {
    required: round2(required),
    requested,
    paid,
    awaiting,
    notYetAsked: Math.max(0, round2(required - requested)),
    balance: Math.max(0, round2(required - paid)),
    partsPaid: paidRows.length,
  };
}

/** Smallest first part allowed without a manager's approval. */
export function minFirstPart(required: number, percent: number = DEFAULT_MIN_FIRST_PART_PERCENT): number {
  return Math.ceil((required * percent) / 100);
}

export type AskCheck =
  | { ok: true; needsOverride: boolean }
  | { ok: false; code: "amount_invalid" | "amount_exceeds_balance" | "open_ask_exists"; balance?: number };

/** Mirror of request_deposit_instalment's checks, for instant feedback in the UI. */
export function checkAsk(
  amount: number,
  pos: DepositPosition,
  hasOpenAsk: boolean,
  percent: number = DEFAULT_MIN_FIRST_PART_PERCENT,
): AskCheck {
  if (hasOpenAsk) return { ok: false, code: "open_ask_exists" };
  if (!(amount > 0)) return { ok: false, code: "amount_invalid" };
  if (amount > pos.balance) return { ok: false, code: "amount_exceeds_balance", balance: pos.balance };
  const firstPart = pos.paid === 0;
  const needsOverride = firstPart && amount < pos.balance && amount < minFirstPart(pos.required, percent);
  return { ok: true, needsOverride };
}

/** Plain-language text for the refusal codes the database functions return. */
export function instalmentErrorMessage(code: string, extra?: { floor?: number; percent?: number; balance?: number }): string {
  const rupees = (n?: number) => `₹${Number(n ?? 0).toLocaleString("en-IN")}`;
  switch (code) {
    case "proposal_not_found": return "Proposal not found";
    case "proposal_not_open": return "This proposal is not open for deposit requests (it must be sent or accepted).";
    case "deposit_not_pending": return "The deposit is already fully paid or not required on this proposal.";
    case "nothing_to_collect": return "There is no deposit left to collect on this proposal.";
    case "open_ask_exists": return "There is already an unpaid part request. Wait for it to be paid, or cancel it first.";
    case "amount_exceeds_balance": return `That is more than the balance still to collect (${rupees(extra?.balance)}).`;
    case "below_floor":
      return `The first part must be at least ${extra?.percent ?? DEFAULT_MIN_FIRST_PART_PERCENT}% of the deposit (${rupees(extra?.floor)}). A manager or admin can approve a smaller one with a reason.`;
    case "not_open": return "That request has already been paid or cancelled.";
    case "instalment_not_found": return "Deposit part not found";
    case "invalid_amount": return "Enter a valid amount";
    default: return "Could not complete the deposit request";
  }
}
