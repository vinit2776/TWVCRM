import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logCommunication } from "@/lib/communications-log";
import { requiredDeposit } from "@/lib/deposit-instalments";
import {
  requestFigures,
  buildPartReceivedEmail,
  buildPartRequestEmail,
  type PartEmailFigures,
  type PartEmailInput,
} from "@/lib/deposit-instalment-email";

/**
 * Loads a part with its proposal and customer, builds the message and (unless
 * previewing) emails it and writes it to communications_log.
 *
 * Email only: WhatsApp keeps the single-amount wording until a template with
 * breakup fields is approved, so a part request is not pushed over WhatsApp here.
 */

export type PartEmailKind = "request" | "received";

interface Loaded {
  input: PartEmailInput;
  to: string | null;
  proposalId: string;
}

async function load(admin: SupabaseClient, instalmentId: string, kind: PartEmailKind): Promise<Loaded | { error: string; status: number }> {
  const { data: part } = await admin
    .from("proposal_deposit_instalments")
    .select("id, proposal_id, seq, amount, status, paid_amount, due_date, customer_message, razorpay_link_url")
    .eq("id", instalmentId)
    .maybeSingle();
  if (!part) return { error: "Deposit part not found", status: 404 };
  if (kind === "request" && part.status !== "requested") return { error: "Only an unpaid, open request can be sent", status: 409 };
  if (kind === "received" && part.status !== "paid") return { error: "That part has not been paid", status: 409 };

  const [{ data: proposal }, { data: rows }] = await Promise.all([
    admin.from("proposals")
      .select("proposal_number, security_deposit_amount, deposit_exception_amount, deposit_credit_amount, lead:leads!proposals_lead_id_fkey(first_name, last_name, email)")
      .eq("id", part.proposal_id)
      .maybeSingle(),
    admin.from("proposal_deposit_instalments")
      .select("amount, status, paid_amount")
      .eq("proposal_id", part.proposal_id),
  ]);
  if (!proposal) return { error: "Proposal not found", status: 404 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  return {
    proposalId: part.proposal_id,
    to: lead?.email || null,
    input: {
      proposalNumber: proposal.proposal_number,
      customerName: lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "Customer" : "Customer",
      seq: part.seq,
      amount: Number(kind === "received" ? part.paid_amount ?? part.amount : part.amount),
      required: requiredDeposit(proposal),
      rows: rows || [],
      payLinkUrl: part.razorpay_link_url,
      dueDate: part.due_date,
      customerMessage: part.customer_message,
    },
  };
}

export interface PartEmailResult {
  ok: boolean;
  error?: string;
  status?: number;
  preview?: { subject: string; html: string; to: string[]; figures: PartEmailFigures };
  sentTo?: string;
}

export async function sendPartEmail(
  admin: SupabaseClient,
  opts: { instalmentId: string; kind: PartEmailKind; preview?: boolean; cc?: string[]; sentBy?: string | null },
): Promise<PartEmailResult> {
  const loaded = await load(admin, opts.instalmentId, opts.kind);
  if ("error" in loaded) return { ok: false, error: loaded.error, status: loaded.status };

  const built = opts.kind === "request" ? buildPartRequestEmail(loaded.input) : buildPartReceivedEmail(loaded.input);
  if (opts.preview) {
    return { ok: true, preview: { subject: built.subject, html: built.html, to: loaded.to ? [loaded.to] : [], figures: built.figures } };
  }
  if (!loaded.to) return { ok: false, error: "Customer email not found on the lead", status: 400 };

  let emailError: string | null = null;
  try {
    const r = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [loaded.to],
      cc: opts.cc && opts.cc.length > 0 ? opts.cc : undefined,
      subject: built.subject,
      html: built.html,
    });
    if (r.error) emailError = r.error.message || "Email provider rejected the send";
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err);
  }
  if (emailError) console.error(`[deposit-instalment-email] ${opts.kind} email failed:`, emailError);

  await logCommunication(admin, {
    entityType: "proposal",
    entityId: loaded.proposalId,
    channel: "email",
    recipient: loaded.to,
    cc: opts.cc ?? [],
    subject: built.subject,
    body: built.html,
    status: emailError ? "failed" : "sent",
    errorMessage: emailError,
    sentBy: opts.sentBy ?? null,
  });

  return emailError ? { ok: false, error: "The email could not be sent", status: 502 } : { ok: true, sentTo: loaded.to };
}

export interface PartPdfDetails {
  proposal_number: string;
  amount: number;
  customer_name: string;
  company: string | null;
  customer_message: string;
  deposit_link_url: string | null;
  due_date: string;
  rows: [string, string][];
  intro: string;
  seq: number;
}

/**
 * Details for the PDF staff share by hand (WhatsApp, the customer's own inbox)
 * when the CRM email isn't used. Sends nothing; writes a "manual" entry to
 * communications_log so the proposal still shows the request went out.
 */
export async function downloadPartRequest(
  admin: SupabaseClient,
  opts: { instalmentId: string; sentBy?: string | null },
): Promise<{ ok: true; details: PartPdfDetails } | { ok: false; error: string; status: number }> {
  const loaded = await load(admin, opts.instalmentId, "request");
  if ("error" in loaded) return { ok: false, error: loaded.error, status: loaded.status };
  const f = requestFigures(loaded.input);
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  const { data: lead } = await admin
    .from("proposals").select("lead:leads!proposals_lead_id_fkey(company)").eq("id", loaded.proposalId).maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const company = ((lead as any)?.lead?.company as string | null) ?? null;
  const due = loaded.input.dueDate ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const details: PartPdfDetails = {
    proposal_number: loaded.input.proposalNumber,
    amount: f.thisPart,
    customer_name: loaded.input.customerName,
    company,
    customer_message: loaded.input.customerMessage ?? "",
    deposit_link_url: loaded.input.payLinkUrl ?? null,
    due_date: due,
    seq: loaded.input.seq,
    intro: `As agreed, the refundable security deposit for proposal ${loaded.input.proposalNumber} is being collected in parts. Please pay ${f.partLabel} of ${inr(f.thisPart)}.`,
    rows: [
      ["Total security deposit", inr(f.required)],
      ["Paid so far", inr(f.paidBefore)],
      [`Requested now (${f.partLabel})`, inr(f.thisPart)],
      ["Balance after this payment", inr(f.balanceAfter)],
    ],
  };
  await logCommunication(admin, {
    entityType: "proposal",
    entityId: loaded.proposalId,
    channel: "manual",
    recipient: "PDF downloaded to share outside the CRM",
    subject: `Security Deposit ${f.partLabel} — ${inr(f.thisPart)} — ${loaded.input.proposalNumber}`,
    body: `${details.intro}\n${details.rows.map(([a, b]) => `${a}: ${b}`).join("\n")}`,
    attachmentName: `Security-Deposit-${loaded.input.proposalNumber}-Part-${f.partLabel.replace("Part ", "")}.pdf`,
    sentBy: opts.sentBy ?? null,
  });
  return { ok: true, details };
}
