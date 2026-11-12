/**
 * Whether a statement has a live proforma (PI) that the early-GST override
 * ("Issue GST Invoice (Override)") can cancel and replace.
 *
 * Deliberately keyed on what actually happened to the statement, not on the
 * contract's *current* billing_mode: the mode only governs future sends, so a
 * contract flipped to GST Direct after a PI already went out (TWV-C-0155)
 * still holds a live PI that someone has to be able to convert.
 */
export const PI_OVERRIDE_ROLES = ["admin", "manager", "accounts", "sales_rep"] as const;

export function canOverridePiToGst(role: string | null | undefined): boolean {
  return !!role && (PI_OVERRIDE_ROLES as readonly string[]).includes(role);
}

export interface PiOverrideStatement {
  status: string;
  payment_status: string | null;
  gst_invoice_number: string | null;
  pi_cancelled_at: string | null;
  proforma_sent_at: string | null;
  voided_at?: string | null;
}

export function hasLivePi(s: PiOverrideStatement): boolean {
  return (
    s.status === "finalized" &&
    !s.voided_at &&
    s.payment_status !== "paid" &&
    !s.gst_invoice_number &&
    !s.pi_cancelled_at &&
    !!s.proforma_sent_at
  );
}
