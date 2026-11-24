import type { SupabaseClient } from "@supabase/supabase-js";
import { mirrorInvoiceToStatement } from "@/lib/adhoc-invoice-mirror";
import { adhocInvoiceTotal } from "@/lib/adhoc-invoice-total";
import { AUTO_ATTRIBUTION_PURPOSE } from "@/lib/adhoc-contract-attach";
import { PURPOSE_LABELS } from "@/lib/noc/rules";
import { customerLink, recordNocEvent } from "@/lib/noc/server";
import { loadNocBundle, type NocBundle } from "@/lib/noc/bundle";
import { logAudit } from "@/lib/audit";

const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export type PrepareResult =
  | { ok: true; bundle: NocBundle; link: string; created: boolean }
  | { ok: false; error: string; status: number };

/**
 * Makes the NOC billable and shareable: creates the ad-hoc invoice (the proforma) for the fee, mirrors it into a
 * billing statement so it follows the normal Receivables reminders and the Tally Inbox handoff, and returns the
 * customer link. Idempotent: a second call returns what the first made. Sends nothing to anyone.
 *
 * Until the customer accepts the terms, the invoice's and statement's payment URL is OUR page, so every route to
 * paying (the email, a reminder, the QR code on the proforma) goes through the acceptance step first. The real
 * gateway link replaces it only after acceptance.
 */
export async function prepareNocInvoice(admin: SupabaseClient, nocId: string, origin: string, actor: { id: string; name: string }): Promise<PrepareResult> {
  const bundle = await loadNocBundle(admin, { id: nocId });
  if (!bundle) return { ok: false, error: "NOC not found", status: 404 };
  const { noc } = bundle;
  if (noc.status === "void") return { ok: false, error: "This order is void.", status: 409 };
  if (noc.status === "paid" || noc.status === "issued") return { ok: false, error: "This NOC is already paid.", status: 409 };
  const link = customerLink(origin, noc.public_token);
  if (noc.invoice_id) return { ok: true, bundle, link, created: false };
  if (!noc.lead_id) return { ok: false, error: "This contract has no customer record to bill.", status: 400 };

  const label = PURPOSE_LABELS[noc.purpose];
  const title = `NOC for ${label} at ${bundle.centreName}`;
  const description = `${title} for ${noc.company_name}, contract ${bundle.contract.contract_number}, valid till ${fmtDate(bundle.contract.end_date)}`;
  const subtotal = bundle.fee.excl;
  const taxAmount = bundle.fee.tax;
  const dueDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const { data: invoice, error } = await admin
    .from("proforma_invoices")
    .insert({
      lead_id: noc.lead_id, contract_id: noc.contract_id, attribution_purpose: AUTO_ATTRIBUTION_PURPOSE,
      attributed_at: new Date().toISOString(), attributed_by: actor.id,
      title, primary_head: "other_income", status: "sent", due_date: dueDate,
      items: [{ description, quantity: 1, unit_price: subtotal, total: subtotal }],
      subtotal, tax_percentage: Number(noc.tax_percentage), tax_amount: taxAmount, discount_percentage: 0, discount_amount: 0,
      total_amount: adhocInvoiceTotal(subtotal, taxAmount, 0),
      // Customer-facing: names the company the GST invoice must be raised to, which can differ from the customer record.
      notes: `Billed for ${noc.company_name}${noc.gstin ? `, GSTIN ${noc.gstin}` : ""}${noc.cin ? `, CIN ${noc.cin}` : ""}. NOC ${bundle.reference}.`,
      // Internal, for accounts: what this is and who the GST invoice is for.
      internal_notes: `NOC service ${noc.noc_number} (${bundle.reference}). Raise the GST invoice to ${noc.company_name}${noc.gstin ? `, GSTIN ${noc.gstin}` : " (no GSTIN given)"}. SAC code to be confirmed with accounts before go-live.`,
      razorpay_link_url: link,
      created_by: actor.id,
    })
    .select("*")
    .single();
  if (error || !invoice) return { ok: false, error: error?.message ?? "Could not create the invoice", status: 500 };

  const { statementId } = await mirrorInvoiceToStatement(admin, invoice, { linkId: null, linkUrl: link });

  const { data: claimed } = await admin
    .from("noc_requests")
    .update({ invoice_id: invoice.id, billing_statement_id: statementId, updated_at: new Date().toISOString() })
    .eq("id", nocId)
    .is("invoice_id", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    // Lost a race with another prepare: keep theirs, retire ours.
    await admin.from("proforma_invoices").update({ status: "cancelled" }).eq("id", invoice.id);
    const again = await loadNocBundle(admin, { id: nocId });
    return again ? { ok: true, bundle: again, link, created: false } : { ok: false, error: "NOC not found", status: 404 };
  }

  await recordNocEvent(admin, nocId, "invoice_created", {
    actorId: actor.id, actorLabel: actor.name,
    detail: { invoice_number: invoice.invoice_number, total: invoice.total_amount, due_date: dueDate, payment_url_is: "customer page until accepted" },
  });
  logAudit(admin, { entityType: "invoice", entityId: invoice.id, action: "create", performedBy: actor.id, changes: { noc: { old: null, new: noc.noc_number } } });
  const fresh = await loadNocBundle(admin, { id: nocId });
  return fresh ? { ok: true, bundle: fresh, link, created: true } : { ok: false, error: "NOC not found", status: 404 };
}

/**
 * Takes a voided NOC's money side with it: cancels the gateway link (best effort), cancels the proforma invoice and
 * voids its billing statement, so it drops out of Receivables and the reminder ladder stops chasing it. Refuses when a
 * payment is already recorded (a paid order needs a credit note, not a void). The same three steps as cancelling an
 * ad-hoc invoice by hand (POST /api/invoices/[id]/cancel), kept here so the NOC void is one action.
 */
export async function cancelNocInvoice(admin: SupabaseClient, nocId: string, actorId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: noc } = await admin.from("noc_requests").select("invoice_id, billing_statement_id, razorpay_link_id").eq("id", nocId).maybeSingle();
  if (!noc?.invoice_id) return { ok: true }; // nothing was ever created, nothing to cancel

  const { data: invoice } = await admin.from("proforma_invoices").select("id, invoice_number, status, notes").eq("id", noc.invoice_id).maybeSingle();
  const { data: statement } = await admin.from("billing_statements").select("id, payment_status, voided_at").eq("invoice_id", noc.invoice_id).maybeSingle();
  if (invoice?.status === "paid" || statement?.payment_status === "paid") return { ok: false, error: "A payment is already recorded for this order, so it cannot be voided. Ask accounts about a credit note." };

  if (noc.razorpay_link_id) {
    try {
      const { data: rows } = await admin.from("app_settings").select("key, value").in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
      const m: Record<string, string> = {};
      (rows ?? []).forEach((r: { key: string; value: string }) => { m[r.key] = r.value; });
      if (m.razorpay_enabled === "true" && m.razorpay_key_id && m.razorpay_key_secret) {
        const auth = Buffer.from(`${m.razorpay_key_id}:${m.razorpay_key_secret}`).toString("base64");
        await fetch(`https://api.razorpay.com/v1/payment_links/${noc.razorpay_link_id}/cancel`, { method: "POST", headers: { Authorization: `Basic ${auth}` } });
      }
    } catch (e) {
      console.warn("[noc void] gateway link cancel failed (non-fatal):", e);
    }
  }
  const now = new Date().toISOString();
  if (invoice && invoice.status !== "cancelled") {
    await admin.from("proforma_invoices").update({ status: "cancelled", notes: `${invoice.notes ? invoice.notes + "\n" : ""}Cancelled: NOC order voided (${reason})` }).eq("id", invoice.id);
  }
  if (statement && !statement.voided_at) {
    await admin.from("billing_statements").update({ status: "voided", voided_at: now, voided_by: actorId, void_reason: `NOC order voided: ${reason}` }).eq("id", statement.id);
  }
  return { ok: true };
}
