import type { SupabaseClient } from "@supabase/supabase-js";
import { generateDepositRequestPDF } from "@/lib/deposit-request-pdf";
import { buildProformaPdf } from "@/lib/proforma-pdf";
import { fetchInvoiceAttachment, type ReminderAttachment } from "@/lib/reminder-invoice-attachment";
import { formatCurrency, formatDate } from "@/lib/pdf-utils";

export type ReceivableAttachmentKind = "deposit" | "topup" | "adhoc_invoice";

export interface ReceivableAttachmentInput {
  kind: ReceivableAttachmentKind;
  id: string;
  reference: string;
  partyName: string;
  amount: number;
  dueDate: string;
  payLinkUrl: string | null;
}

export interface ReceivableAttachment extends ReminderAttachment {
  /** What the email should call it ("tax invoice", "proforma", ...). */
  docNoun: string;
}

const safe = (ref: string) => ref.replace(/[\\/]/g, "-");

const pdf = (filename: string, content: Buffer): Pick<ReminderAttachment, "filename" | "content" | "contentType"> =>
  ({ filename, content, contentType: "application/pdf" });

/**
 * The document the customer is being chased for, for receivables that live
 * outside billing_statements:
 *   • deposit  → the one-page Security Deposit Request the team already
 *                downloads from the proposal screen, rebuilt with the live
 *                balance and pay link;
 *   • topup    → the same layout titled "Additional Security Deposit
 *                Request" (top-ups have no PDF of their own);
 *   • ad-hoc   → the GST tax invoice once issued, otherwise the live
 *                proforma layout from the linked statement, otherwise the PDF
 *                saved when the invoice was emailed.
 *
 * Read-only. Returns null on any failure — a missing attachment must never
 * stop the reminder, so the email goes out with the amount and pay link.
 */
export async function fetchReceivableAttachment(
  admin: SupabaseClient,
  input: ReceivableAttachmentInput,
): Promise<ReceivableAttachment | null> {
  try {
    if (input.kind === "deposit") return await depositAttachment(admin, input);
    if (input.kind === "topup") return await topupAttachment(input);
    return await adhocAttachment(admin, input);
  } catch (err) {
    console.error(`[receivable-reminder] ${input.kind} attachment failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function depositAttachment(admin: SupabaseClient, i: ReceivableAttachmentInput): Promise<ReceivableAttachment | null> {
  const { data: p } = await admin
    .from("proposals")
    .select("proposal_number, security_deposit_months, lead:leads!proposals_lead_id_fkey(first_name, last_name, company)")
    .eq("id", i.id)
    .maybeSingle();
  if (!p) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = p.lead as any;
  const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || i.partyName;
  const doc = await generateDepositRequestPDF({
    proposal_number: p.proposal_number as string,
    amount: i.amount,
    security_deposit_months: Number(p.security_deposit_months) || 1,
    customer_name: name,
    company: lead?.company ?? null,
    // The sender's free-text note isn't stored, so reminders never repeat it.
    customer_message: "",
    deposit_link_url: i.payLinkUrl,
    due_date: i.dueDate,
  });
  return { ...pdf(`Security-Deposit-${safe(p.proposal_number as string)}.pdf`, Buffer.from(doc.output("arraybuffer"))), docNoun: "deposit request" };
}

async function topupAttachment(i: ReceivableAttachmentInput): Promise<ReceivableAttachment | null> {
  const doc = await generateDepositRequestPDF({
    proposal_number: i.reference,
    amount: i.amount,
    security_deposit_months: 1,
    customer_name: i.partyName,
    company: null,
    customer_message: "",
    deposit_link_url: i.payLinkUrl,
    due_date: i.dueDate,
    variant: {
      title: "Additional Security Deposit Request",
      intro: `Please pay the additional refundable security deposit below for contract ${i.reference}.`,
      rows: [
        ["Contract", i.reference],
        ["Amount", formatCurrency(i.amount)],
        ["Please pay by", formatDate(i.dueDate + "T00:00:00")],
      ],
      paymentReference: i.reference,
    },
  });
  return { ...pdf(`Additional-Deposit-${safe(i.reference)}.pdf`, Buffer.from(doc.output("arraybuffer"))), docNoun: "deposit request" };
}

async function adhocAttachment(admin: SupabaseClient, i: ReceivableAttachmentInput): Promise<ReceivableAttachment | null> {
  const { data: statement } = await admin
    .from("billing_statements")
    .select("id, gst_invoice_number, gst_invoice_path")
    .eq("invoice_id", i.id)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A tax invoice supersedes the proforma — never send the old one.
  if (statement?.gst_invoice_number) {
    const a = await fetchInvoiceAttachment(admin, statement);
    return a ? { ...a, docNoun: "tax invoice" } : null;
  }

  // The live proforma layout, rebuilt from the linked statement. Preferred
  // over the PDF saved at email time, which is an older, simpler layout.
  if (statement) {
    const r = await buildProformaPdf(admin, statement.id as string);
    if (r.ok) return { ...pdf(r.filename, r.buffer), docNoun: "proforma invoice" };
  }

  // No usable statement: fall back to the PDF saved when the invoice was
  // first emailed (invoices/<id>/…).
  const { data: files } = await admin.storage
    .from("crm-documents")
    .list(`invoices/${i.id}`, { limit: 1, sortBy: { column: "created_at", order: "desc" } });
  const latest = files?.[0];
  if (latest) {
    const { data: blob, error } = await admin.storage.from("crm-documents").download(`invoices/${i.id}/${latest.name}`);
    if (!error && blob) {
      return { ...pdf(`${safe(i.reference)}.pdf`, Buffer.from(await blob.arrayBuffer())), docNoun: "proforma invoice" };
    }
  }
  return null;
}
