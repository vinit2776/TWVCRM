import { createAdminClient } from "@/lib/supabase/server";
import { loadNocBundle, leadDisplayName } from "@/lib/noc/bundle";
import { recordNocEvent } from "@/lib/noc/server";
import { buildReceiptEmail } from "@/lib/noc/emails";
import { sendNocEmail } from "@/lib/noc/send";
import { PURPOSE_LABELS } from "@/lib/noc/rules";

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const fmtYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Called from handleStatementPaid, the one function every way of recording a full payment goes through (the gateway
 * webhook, accounts recording a bank payment, accounts verifying a reported payment). If the invoice belongs to a NOC
 * order, the order becomes paid and the customer gets a receipt with the acceptance certificate attached.
 *
 * Idempotent: an order that is already paid is left alone, so it is safe to call again (see reconcileNocPaid).
 * Never throws: a problem here must not undo or block the payment itself. Anything that goes wrong is written to the
 * audit trail instead.
 */
export async function syncNocOnPaid(invoiceId: string, statementId: string, trigger: string, performedBy: string | null): Promise<void> {
  try {
    // Its own service-role client: callers may hand over a signed-in user's client, which row-level security stops from
    // updating NOC orders (that silently matched no row the first time this was tried).
    const admin = createAdminClient();
    const { data: row } = await admin.from("noc_requests").select("id, status").eq("invoice_id", invoiceId).maybeSingle();
    if (!row || !["draft", "sent", "accepted"].includes(row.status)) return;

    const { data: last } = await admin
      .from("billing_payments").select("payment_reference").eq("billing_statement_id", statementId)
      .order("payment_date", { ascending: false }).limit(1).maybeSingle();
    const now = new Date().toISOString();
    const { data: moved } = await admin
      .from("noc_requests")
      .update({ status: "paid", paid_at: now, payment_reference: last?.payment_reference ?? null, updated_at: now })
      .eq("id", row.id).in("status", ["draft", "sent", "accepted"]).select("id").maybeSingle();
    if (!moved) return;

    const b = await loadNocBundle(admin, { id: row.id });
    if (!b) return;
    const accepted = !!b.noc.accepted_at;
    await recordNocEvent(admin, row.id, "payment_received", {
      actorId: performedBy, actorLabel: trigger === "reconcile" ? "system (caught up)" : performedBy ? "accounts" : "payment gateway",
      detail: { amount: b.total, reference: last?.payment_reference ?? null, via: trigger, statement_balance: 0, terms_accepted: accepted },
    });
    if (!accepted) {
      await recordNocEvent(admin, row.id, "paid_without_acceptance", { actorLabel: "system", detail: { note: "Paid outside the customer page. The customer must still accept the terms on the link before the NOC is issued." } });
    }

    // Receipt, with the acceptance certificate when there is one. Best effort.
    const to = b.noc.sent_to || b.lead?.email;
    if (!to) { await recordNocEvent(admin, row.id, "receipt_skipped", { actorLabel: "system", detail: { reason: "no email on record" } }); return; }
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    if (b.noc.acceptance_document_id) {
      const { data: doc } = await admin.from("documents").select("file_path, file_name").eq("id", b.noc.acceptance_document_id).maybeSingle();
      if (doc) {
        const dl = await admin.storage.from("crm-documents").download(doc.file_path);
        if (dl.data) attachments.push({ filename: doc.file_name, content: Buffer.from(await dl.data.arrayBuffer()), contentType: "application/pdf" });
      }
    }
    const { data: inv } = b.noc.invoice_id ? await admin.from("proforma_invoices").select("invoice_number").eq("id", b.noc.invoice_id).maybeSingle() : { data: null };
    const mail = buildReceiptEmail({
      customerName: leadDisplayName(b.lead), companyName: b.noc.company_name, purposeLabel: PURPOSE_LABELS[b.noc.purpose], centre: b.centreName,
      total: b.total, paidOnLabel: fmt(now), reference: last?.payment_reference ?? null, validUntilLabel: fmtYmd(b.contract.end_date), invoiceNumber: inv?.invoice_number ?? "",
    });
    const sent = await sendNocEmail(admin, { to, subject: mail.subject, html: mail.html, attachments });
    await recordNocEvent(admin, row.id, sent.ok ? "receipt_emailed" : "receipt_not_sent", { actorLabel: "system", detail: sent.ok ? { to, attached_certificate: attachments.length > 0 } : { to, error: sent.error } });
  } catch (e) {
    console.error("[noc] syncNocOnPaid failed", e);
  }
}

/**
 * Safety net for a payment that was recorded but never reached the NOC order (a different route, or a retry): if the
 * order is not yet paid but its invoice is, run the same sync. Cheap, so it runs whenever an order is read.
 */
export async function reconcileNocPaid(noc: { id: string; status: string; invoice_id: string | null; billing_statement_id: string | null }): Promise<boolean> {
  if (!noc.invoice_id || !noc.billing_statement_id || !["draft", "sent", "accepted"].includes(noc.status)) return false;
  const admin = createAdminClient();
  const { data: inv } = await admin.from("proforma_invoices").select("status").eq("id", noc.invoice_id).maybeSingle();
  if (inv?.status !== "paid") return false;
  await syncNocOnPaid(noc.invoice_id, noc.billing_statement_id, "reconcile", null);
  return true;
}
