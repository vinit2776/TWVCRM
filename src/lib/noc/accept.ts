import type { SupabaseClient } from "@supabase/supabase-js";
import { createNocPaymentLink, type NocLinkResult } from "@/lib/noc/payment-link";
import { customerLink, recordNocEvent } from "@/lib/noc/server";
import { razorpayLinkDates } from "@/lib/razorpay-link-dates";
import type { NocBundle } from "@/lib/noc/bundle";
import { leadDisplayName } from "@/lib/noc/bundle";
import { PURPOSE_LABELS } from "@/lib/noc/rules";

/**
 * Makes sure an accepted order has its gateway link, creating it once. Called right after the customer accepts, and
 * again by staff if the first attempt failed (the gateway was down, or online payment is not switched on yet).
 * Never creates a second link for an order that already has one. On success the invoice and the billing statement
 * carry the real link, so the webhook books the payment the same way as any ad-hoc invoice.
 */
export async function ensureGatewayLink(admin: SupabaseClient, b: NocBundle, origin: string, actor?: { id: string; name: string }): Promise<NocLinkResult | { ok: true; id: string; url: string; expiresAt: null; existing: true }> {
  const { noc } = b;
  if (noc.razorpay_link_id && noc.razorpay_link_url) return { ok: true, id: noc.razorpay_link_id, url: noc.razorpay_link_url, expiresAt: null, existing: true };
  if (!noc.invoice_id) return { ok: false, reason: "gateway", error: "The order has no invoice yet." };

  const { data: invoice } = await admin.from("proforma_invoices").select("id, invoice_number, title, total_amount").eq("id", noc.invoice_id).single();
  if (!invoice) return { ok: false, reason: "gateway", error: "The invoice was not found." };

  const result = await createNocPaymentLink(admin, {
    totalRupees: Number(invoice.total_amount), invoiceNumber: invoice.invoice_number, title: `${invoice.title}`, invoiceId: invoice.id,
    nocId: noc.id, nocNumber: noc.noc_number, token: noc.public_token, appUrl: origin,
    customer: { name: noc.accepted_by_name ? `${noc.accepted_by_name}, ${noc.company_name}` : noc.company_name, email: noc.sent_to ?? b.lead?.email ?? undefined, phone: b.lead?.mobile ?? b.lead?.phone ?? undefined },
  });

  if (!result.ok) {
    await recordNocEvent(admin, noc.id, "payment_link_failed", { actorId: actor?.id ?? null, actorLabel: actor?.name ?? "system", detail: { reason: result.reason, error: result.error } });
    return result;
  }
  const dates = razorpayLinkDates({ expire_by: result.expiresAt ?? undefined, created_at: Math.floor(Date.now() / 1000) });
  await admin.from("noc_requests").update({ razorpay_link_id: result.id, razorpay_link_url: result.url, updated_at: new Date().toISOString() }).eq("id", noc.id);
  await admin.from("proforma_invoices").update({ razorpay_link_id: result.id, razorpay_link_url: result.url, ...dates }).eq("id", noc.invoice_id);
  if (noc.billing_statement_id) await admin.from("billing_statements").update({ razorpay_payment_link_id: result.id, razorpay_payment_link_url: result.url }).eq("id", noc.billing_statement_id);
  await recordNocEvent(admin, noc.id, "payment_link_created", { actorId: actor?.id ?? null, actorLabel: actor?.name ?? "system", detail: { gateway_link_id: result.id, amount: Number(invoice.total_amount) } });
  return result;
}

/** What the public page shows. Contains nothing the customer should not see (no staff names, no audit detail). */
export function publicView(b: NocBundle, extra: { codeDestination: string | null; payUrl: string | null; linkProblem: string | null; invoiceNumber: string | null; validUntilLabel: string }) {
  const { noc } = b;
  return {
    reference: b.reference,
    company: noc.company_name,
    centre: b.centreName,
    purposeLabel: PURPOSE_LABELS[noc.purpose],
    address: noc.noc_address,
    fee: b.fee,
    taxPercentage: Number(noc.tax_percentage),
    validUntilLabel: extra.validUntilLabel,
    status: noc.status,
    accepted: !!noc.accepted_at,
    acceptedBy: noc.accepted_by_name,
    paid: noc.status === "paid" || noc.status === "issued",
    payment: noc.paid_at ? { amount: b.total, paidAt: noc.paid_at, reference: noc.payment_reference, invoiceNumber: extra.invoiceNumber } : null,
    codeDestination: extra.codeDestination,
    payUrl: extra.payUrl,
    linkProblem: extra.linkProblem,
    link: customerLink("", noc.public_token),
    customerName: leadDisplayName(b.lead),
  };
}
