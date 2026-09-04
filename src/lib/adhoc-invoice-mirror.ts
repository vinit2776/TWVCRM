import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";

interface MirrorableInvoice {
  id: string;
  proposal_id: string | null;
  case_id: string | null;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  due_date: string | null;
  title: string;
  items: Array<{ description: string; quantity: number; unit_price: number; total: number }> | null;
}

/**
 * Mirrors an ad-hoc invoice into billing_statements so it flows through the
 * same AR follow-up ladder and Tally GST handoff every other invoice type
 * uses — regardless of how the invoice actually reached the customer.
 * Originally this only ran when the invoice was emailed through the CRM
 * (POST /api/invoices/[id]/email); "Mark as Sent" flipped the status label
 * without calling it, so an invoice handed over some other way (downloaded
 * and shared on WhatsApp, say) never entered the AR pipeline at all — no
 * Detail-view row, no "Report paid", nothing to record against.
 *
 * Idempotent on invoice_id: a re-run (resend, or marking sent after an
 * earlier partial failure) refreshes the Razorpay link on the existing row
 * instead of creating a duplicate statement.
 */
export async function mirrorInvoiceToStatement(
  admin: SupabaseClient,
  invoice: MirrorableInvoice,
  razorpay: { linkId: string | null; linkUrl: string | null },
): Promise<{ dueDate: string; statementId: string }> {
  // The AR reminder ladder reads due_date off the invoice row directly, not
  // off this mirror — callers persist this back onto proforma_invoices
  // themselves when the invoice didn't already have one.
  const dueDate = invoice.due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: existingStatement } = await admin
    .from("billing_statements")
    .select("id")
    .eq("invoice_id", invoice.id)
    .maybeSingle();

  if (existingStatement) {
    if (razorpay.linkUrl) {
      await admin
        .from("billing_statements")
        .update({ razorpay_payment_link_id: razorpay.linkId, razorpay_payment_link_url: razorpay.linkUrl })
        .eq("id", existingStatement.id);
    }
    return { dueDate, statementId: existingStatement.id as string };
  }

  const todayYmd = new Date().toISOString().slice(0, 10);
  const lineItems = (invoice.items || []).map((item) => ({
    description: item.description,
    qty: item.quantity,
    unit_price: item.unit_price,
    amount: item.total,
    hsn_sac_code: resolveHsnCode("ad_hoc_charges"),
  }));

  const { data: newStatement } = await admin.from("billing_statements").insert({
    invoice_id: invoice.id,
    contract_id: null,
    proposal_id: invoice.proposal_id ?? null,
    // Carry the case through to the mirrored statement. This is what makes
    // the Tally Inbox, receivables and the payment panel resolve the right
    // buyer: they read the statement, and billing_statements already routes
    // a case's buyer via voBillParty(). Without it a case-raised invoice
    // would show a blank party downstream.
    case_id: invoice.case_id ?? null,
    statement_type: "usage",
    created_via: "adhoc_invoice",
    status: "finalized",
    payment_status: "unpaid",
    handoff_state: "pi_awaiting_payment",
    period_start: todayYmd,
    period_end: todayYmd,
    subtotal: invoice.subtotal,
    fixed_amount: invoice.subtotal,
    tax_percentage: invoice.tax_percentage,
    tax_amount: invoice.tax_amount,
    total_amount: invoice.total_amount,
    due_date: dueDate,
    razorpay_payment_link_id: razorpay.linkId,
    razorpay_payment_link_url: razorpay.linkUrl,
    line_items: [{ type: "usage", label: invoice.title, items: lineItems, subtotal: invoice.subtotal }],
  }).select("id").single();

  return { dueDate, statementId: newStatement!.id as string };
}
