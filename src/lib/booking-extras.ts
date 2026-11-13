/**
 * Pure rules for extras added to a walk-in or guest booking after checkout, and for how
 * they reach the booking's Tally tasks. No Supabase, so they unit test.
 *
 * The idea: an extra becomes a line on the booking, which reopens its balance. The
 * booking's Tally task is held until that balance is paid, and if accounts already
 * issued the GST invoice, the extra gets a supplementary task of its own.
 */

import { bookingPaymentTolerance } from "@/lib/booking-payment-rules";

/** Contract holders keep the old route: their extras go to the next monthly invoice. */
export function postCheckoutExtrasAllowed(b: {
  status: string;
  customer_type: string | null;
  contract_id: string | null;
}): boolean {
  return b.status === "checked_out" && b.customer_type !== "contract_holder" && !b.contract_id;
}

/**
 * After an extra changes the total: still paid if the money received covers it, else pending.
 * The usual tolerance (₹10 / 2%) is for rounding on a UPI amount, not for letting a small
 * extra go uncollected, so what the extra itself added is taken off the allowance.
 */
export function paymentStatusForTotal(total: number, verifiedPaid: number, added = 0): "paid" | "pending" {
  const allowance = Math.max(bookingPaymentTolerance(total) - Math.max(added, 0), 0.5);
  return verifiedPaid >= total - allowance ? "paid" : "pending";
}

export interface TaskLike {
  kind: string;
  sequence: number;
  amount_with_gst: number | string | null;
  handoff_state: string;
  gst_invoice_number: string | null;
  tally_invoice_number: string | null;
  voided_at: string | null;
}

/** True while accounts have not started the GST invoice for this task. */
export function isTaskUnissued(t: Pick<TaskLike, "handoff_state" | "gst_invoice_number" | "tally_invoice_number" | "voided_at">): boolean {
  return !t.voided_at && t.handoff_state === "gst_to_issue" && !t.gst_invoice_number && !t.tally_invoice_number;
}

export type TaskPlan =
  | { action: "none" }
  | { action: "create_main"; amount: number }
  | { action: "refresh"; taskIndex: number; amount: number }
  | { action: "create_supplement"; sequence: number; amount: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What to do with the booking's Tally tasks once it is checked out and fully paid.
 *  - no task yet: create the main one for the whole total;
 *  - the latest task is still unissued: refresh its amount to cover everything not
 *    already on an issued task (the extra folds into the one invoice);
 *  - everything is issued and the total has grown: a supplement for the difference;
 *  - a voided main task stays voided (accounts did that on purpose).
 */
export function planGstTasks(bookingTotal: number, tasks: TaskLike[]): TaskPlan {
  const ordered = [...tasks].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length === 0) return { action: "create_main", amount: round2(bookingTotal) };
  if (ordered[0].voided_at && ordered.length === 1) return { action: "none" };

  const live = ordered.filter((t) => !t.voided_at);
  const latest = live[live.length - 1];
  if (!latest) return { action: "none" };

  const issuedTotal = live
    .filter((t) => t !== latest || !isTaskUnissued(t))
    .reduce((s, t) => s + Number(t.amount_with_gst ?? 0), 0);

  if (isTaskUnissued(latest)) {
    const amount = round2(bookingTotal - live.filter((t) => t !== latest).reduce((s, t) => s + Number(t.amount_with_gst ?? 0), 0));
    return amount > 0 ? { action: "refresh", taskIndex: ordered.indexOf(latest), amount } : { action: "none" };
  }

  const delta = round2(bookingTotal - issuedTotal);
  if (delta >= 1) {
    return { action: "create_supplement", sequence: ordered[ordered.length - 1].sequence + 1, amount: delta };
  }
  return { action: "none" };
}

/** Why an unissued task is waiting, or null when it can go ahead. */
export function holdReason(args: { unissued: boolean; bookingPaymentStatus: string; balance: number }): string | null {
  if (!args.unissued || args.bookingPaymentStatus === "paid") return null;
  return args.balance > 0
    ? `Waiting for ₹${Math.round(args.balance).toLocaleString("en-IN")} extra to be paid`
    : "Waiting for the booking's payment to be confirmed";
}
