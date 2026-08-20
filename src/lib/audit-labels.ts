// Turn raw audit_trail rows into something a human can read.
//
// The audit_trail table stores every mutation as `action: "update"` with a
// `changes` blob like `{ approval_status: { old: "pending", new: "approved" }}`.
// Rendered raw, the timeline reads as 10 identical "Updated Invoice" rows.
// This helper inspects the changes blob and returns a specific label + tone
// for the most common state transitions, falling back to the generic
// "Updated" so unknown shapes still render.

export type AuditChange = { old: unknown; new: unknown };
export type AuditChanges = Record<string, AuditChange>;

export type AuditSummary = {
  /** Short imperative label shown as the event headline. */
  label: string;
  /** Tailwind tone classes for the dot + heading text. */
  tone: "blue" | "green" | "red" | "amber" | "purple" | "grey" | "teal";
  /** Optional one-line detail rendered under the label (UTRs, amounts, reasons). */
  detail?: string;
};

const INR = (v: unknown) =>
  typeof v === "number" || (typeof v === "string" && !isNaN(Number(v)))
    ? `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : "—";

const has = (c: AuditChanges, key: string) => Object.prototype.hasOwnProperty.call(c, key);
const went = (c: AuditChanges, key: string, from: unknown, to: unknown) =>
  has(c, key) && c[key].old === from && c[key].new === to;

function summarizeContract(c: AuditChanges, action: string): AuditSummary | null {
  if (action === "contract_extended" && has(c, "days_added")) {
    const daysAdded = c.days_added.new as number;
    const newEndDate = (c.end_date?.new as string | null) ?? null;
    const reason = (c.reason?.new as string | null) ?? null;
    return {
      label: `Extended by ${daysAdded} day${daysAdded === 1 ? "" : "s"}`,
      tone: "blue",
      detail: [newEndDate ? `now expires ${newEndDate}` : null, reason].filter(Boolean).join(" · ") || undefined,
    };
  }
  return null;
}

function summarizeVendorBill(c: AuditChanges, action: string): AuditSummary | null {
  // ── Approval flow ──────────────────────────────────────────────────────
  if (went(c, "approval_status", "pending", "approved")) {
    const partial =
      has(c, "approved_amount") &&
      has(c, "approved_amount_reason") &&
      c.approved_amount.new !== c.approved_amount.old;
    if (partial) {
      const reason = (c.approved_amount_reason?.new as string | null) ?? "";
      return {
        label: "Partially approved for payment",
        tone: "amber",
        detail: `Approved ${INR(c.approved_amount.new)}${reason ? ` · reason: ${reason}` : ""}`,
      };
    }
    return { label: "Approved for payment", tone: "green" };
  }
  if (went(c, "approval_status", "pending", "rejected")) {
    const reason = (c.rejection_reason?.new as string | null) ?? "";
    return { label: "Rejected", tone: "red", detail: reason || undefined };
  }
  if (went(c, "approval_status", "rejected", "pending")) {
    return { label: "Resubmitted for approval", tone: "blue" };
  }

  // ── Approved amount corrected (post-approval mismatch fix) ─────────────
  if (has(c, "total_amount") && c.total_amount.new !== c.total_amount.old && has(c, "amount_correction_reason")) {
    const reason = (c.amount_correction_reason?.new as string | null) ?? "";
    return {
      label: "Approved amount corrected",
      tone: "amber",
      detail: `${INR(c.total_amount.old)} → ${INR(c.total_amount.new)}${reason ? ` · ${reason}` : ""}`,
    };
  }

  // ── Payment recorded (real money moved) ────────────────────────────────
  if (has(c, "amount_paid") && Number(c.amount_paid.new) > Number(c.amount_paid.old ?? 0)) {
    const delta = Number(c.amount_paid.new) - Number(c.amount_paid.old ?? 0);
    const mode = (c.payment_mode?.new as string | null) ?? null;
    const ref = (c.payment_reference?.new as string | null) ?? null;
    const partialReason = (c.partial_payment_reason?.new as string | null) ?? null;
    const isPartial = c.payment_status?.new === "partially_paid";
    const bits = [
      mode ? mode.replace(/_/g, " ").toUpperCase() : null,
      ref ? `Ref ${ref}` : null,
      partialReason ? `partial: ${partialReason}` : null,
    ].filter(Boolean);
    return {
      label: `${isPartial ? "Partial payment" : "Payment"} recorded — ${INR(delta)}`,
      tone: isPartial ? "amber" : "blue",
      detail: bits.length ? bits.join(" · ") : undefined,
    };
  }

  // ── PO advance pre-credited at bill creation ──────────────────────────
  if (
    has(c, "amount_paid") &&
    !has(c, "payment_mode") &&
    Number(c.amount_paid.new) > Number(c.amount_paid.old ?? 0)
  ) {
    return {
      label: "Pre-credited from PO advance",
      tone: "purple",
      detail: INR(c.amount_paid.new),
    };
  }
  // ── PO advance pre-credit REVERSED (backfill / Finance re-route) ──────
  if (
    has(c, "amount_paid") &&
    Number(c.amount_paid.new) < Number(c.amount_paid.old ?? 0) &&
    c.payment_status?.new === "unpaid"
  ) {
    return {
      label: "Advance pre-credit reversed",
      tone: "grey",
      detail: "Re-routed through Finance for proper UTR capture",
    };
  }

  // ── GST set / corrected ───────────────────────────────────────────────
  if (has(c, "gst_amount") && c.gst_amount.new !== c.gst_amount.old) {
    return {
      label: "GST amount set",
      tone: "grey",
      detail: INR(c.gst_amount.new),
    };
  }

  // ── Batch schedule changes ────────────────────────────────────────────
  if (has(c, "payment_batch_date") || has(c, "payment_batch_type")) {
    const newDate = c.payment_batch_date?.new ?? c.payment_batch_type?.new;
    return {
      label: "Payment batch rescheduled",
      tone: "grey",
      detail: newDate ? `New batch: ${String(newDate)}` : undefined,
    };
  }

  // ── Hold lifecycle ────────────────────────────────────────────────────
  if (went(c, "payment_hold_status", null, "on_hold") || went(c, "payment_hold_status", undefined, "on_hold")) {
    const reason = (c.payment_hold_reason?.new as string | null) ?? "";
    return { label: "Payment placed on hold", tone: "amber", detail: reason || undefined };
  }
  if (has(c, "payment_hold_status") && c.payment_hold_status.new === null) {
    return { label: "Payment hold released", tone: "green" };
  }

  // ── Due-date correction ───────────────────────────────────────────────
  if (has(c, "due_date") && c.due_date.new !== c.due_date.old) {
    return {
      label: "Due date updated",
      tone: "grey",
      detail: `${String(c.due_date.old ?? "—")} → ${String(c.due_date.new ?? "—")}`,
    };
  }

  if (action === "create") return { label: "Invoice created", tone: "blue" };
  return null;
}

function summarizePurchaseOrder(c: AuditChanges, action: string): AuditSummary | null {
  // ── Advance released by Finance (the headline for BILL-2606-069 case) ──
  if (went(c, "advance_status", "pending", "processed")) {
    const ref = (c.advance_payment_reference?.new as string | null) ?? null;
    const mode = (c.advance_payment_mode?.new as string | null) ?? null;
    const amt = (c.advance_amount?.new as number | null) ?? null;
    const bits = [
      amt != null ? INR(amt) : null,
      mode ? mode.replace(/_/g, " ").toUpperCase() : null,
      ref ? `Ref ${ref}` : null,
    ].filter(Boolean);
    return {
      label: "PO advance released",
      tone: "purple",
      detail: bits.length ? bits.join(" · ") : undefined,
    };
  }
  // ── Advance UNDONE (backfill reset) ────────────────────────────────────
  if (went(c, "advance_status", "processed", "pending")) {
    return {
      label: "Advance reset to pending",
      tone: "grey",
      detail: "Re-routed through Finance for proper UTR capture",
    };
  }
  // ── Invoice approval propagates to PO status ──────────────────────────
  if (went(c, "status", "invoice_received", "invoice_approved")) {
    return { label: "Linked invoice approved", tone: "green" };
  }
  if (went(c, "status", "draft", "approved")) {
    return { label: "PO approved", tone: "green" };
  }
  if (has(c, "status") && c.status.new === "cancelled") {
    return { label: "PO cancelled", tone: "red" };
  }
  if (action === "create") return { label: "PO raised", tone: "blue" };
  return null;
}

function summarizePurchaseRequest(c: AuditChanges, action: string): AuditSummary | null {
  if (went(c, "status", "draft", "submitted")) return { label: "Submitted for approval", tone: "blue" };
  if (went(c, "status", "submitted", "approved")) return { label: "Material request approved", tone: "green" };
  if (went(c, "status", "submitted", "rejected")) return { label: "Material request rejected", tone: "red" };
  if (action === "procurement_approval_revoked") {
    const reason = (c.reason?.new as string | null) ?? null;
    return { label: "Approval revoked — back to Pending Approval", tone: "amber", detail: reason ?? undefined };
  }
  if (action === "procurement_chain_cancelled") {
    const reason = (c.reason?.new as string | null) ?? null;
    return { label: "Material request cancelled (chain reversed)", tone: "red", detail: reason ?? undefined };
  }
  if (action === "create") return { label: "Material request created", tone: "blue" };
  return null;
}

const GENERIC_BY_ACTION: Record<string, AuditSummary> = {
  create:     { label: "Created", tone: "blue" },
  delete:     { label: "Deleted", tone: "red" },
  email_sent: { label: "Email sent", tone: "teal" },
  approved:   { label: "Approved", tone: "green" },
  rejected:   { label: "Rejected", tone: "red" },
  login:      { label: "Logged in", tone: "grey" },
};

/**
 * Best-effort transform from a raw audit_trail row to a human-friendly
 * label + tone + detail. When no rule matches the fallback is a generic
 * "Updated [entity]" — same as today.
 */
export function summarizeAuditEvent(row: {
  entity_type: string;
  action: string;
  changes: AuditChanges | null;
}): AuditSummary {
  const changes = row.changes ?? {};
  let specific: AuditSummary | null = null;

  if (row.entity_type === "contract") specific = summarizeContract(changes, row.action);
  else if (row.entity_type === "vendor_bill") specific = summarizeVendorBill(changes, row.action);
  else if (row.entity_type === "purchase_order") specific = summarizePurchaseOrder(changes, row.action);
  else if (row.entity_type === "purchase_request") specific = summarizePurchaseRequest(changes, row.action);

  if (specific) return specific;
  if (GENERIC_BY_ACTION[row.action]) return GENERIC_BY_ACTION[row.action];
  return { label: "Updated", tone: "grey" };
}

/** Tailwind class mapping for the dot/badge tone. */
export const AUDIT_TONE_DOT: Record<AuditSummary["tone"], string> = {
  blue:   "bg-blue-500",
  green:  "bg-emerald-500",
  red:    "bg-red-500",
  amber:  "bg-amber-500",
  purple: "bg-purple-500",
  grey:   "bg-gray-400",
  teal:   "bg-teal-500",
};

export const AUDIT_TONE_TEXT: Record<AuditSummary["tone"], string> = {
  blue:   "text-blue-700",
  green:  "text-emerald-700",
  red:    "text-red-700",
  amber:  "text-amber-700",
  purple: "text-purple-700",
  grey:   "text-foreground",
  teal:   "text-teal-700",
};
