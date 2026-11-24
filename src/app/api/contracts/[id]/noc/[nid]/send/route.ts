import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { logEmailActivity } from "@/lib/audit";
import { appOrigin, clientIp, loadNocSettings, recordNocEvent } from "@/lib/noc/server";
import { canOrderNoc, PURPOSE_LABELS } from "@/lib/noc/rules";
import { prepareNocInvoice } from "@/lib/noc/prepare";
import { leadDisplayName } from "@/lib/noc/bundle";
import { buildOfferEmail } from "@/lib/noc/emails";
import { sendNocEmail } from "@/lib/noc/send";
import { unsafeRecipientReason } from "@/lib/noc/safe-send";
import { buildAdhocInvoicePdf } from "@/lib/adhoc-proforma-pdf";

export const maxDuration = 30;

const bodySchema = z.object({ preview: z.boolean().optional(), to: z.string().trim().email("Enter a valid email address").optional() });
const fmtYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * POST /api/contracts/[id]/noc/[nid]/send   { preview?: boolean, to?: string }
 * Emails the customer the proforma invoice and the link to our NOC page. `preview: true` builds the message and
 * sends nothing. A real send is refused unless the address is safe to message (see safe-send.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canOrderNoc(actor.role)) return NextResponse.json({ error: "Your role cannot send a NOC to a customer" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const { data: own } = await admin.from("noc_requests").select("id, status").eq("id", nid).eq("contract_id", id).maybeSingle();
  if (!own) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  if (!["draft", "sent"].includes(own.status)) return NextResponse.json({ error: own.status === "void" ? "This order is void." : "The customer has already accepted the terms, so there is nothing more to send." }, { status: 409 });

  const prep = await prepareNocInvoice(admin, nid, appOrigin(req.url), actor);
  if (!prep.ok) return NextResponse.json({ error: prep.error }, { status: prep.status });
  const b = prep.bundle;
  const to = parsed.data.to || b.noc.sent_to || b.lead?.email || "";
  if (!to) return NextResponse.json({ error: "There is no email address for this customer. Enter one to send to." }, { status: 422 });

  const { data: inv } = await admin.from("proforma_invoices").select("invoice_number").eq("id", b.noc.invoice_id!).single();
  const pi = await buildAdhocInvoicePdf(admin, b.noc.invoice_id!);
  const mail = buildOfferEmail({
    customerName: leadDisplayName(b.lead), companyName: b.noc.company_name, purposeLabel: PURPOSE_LABELS[b.noc.purpose], centre: b.centreName,
    feeExcl: b.fee.excl, tax: b.fee.tax, taxPercentage: Number(b.noc.tax_percentage), total: b.fee.total, validUntilLabel: fmtYmd(b.contract.end_date),
    invoiceNumber: inv?.invoice_number ?? "", link: prep.link,
  });
  const attachment = pi.ok ? { filename: pi.filename, content: pi.buffer, contentType: "application/pdf" } : null;

  if (parsed.data.preview) {
    return NextResponse.json({ data: { preview: true, to, subject: mail.subject, html: mail.html, attachment: attachment?.filename ?? null, piProblem: pi.ok ? null : pi.error, blockedReason: unsafeRecipientReason(to), link: prep.link } });
  }
  if (!attachment) return NextResponse.json({ error: `The proforma invoice could not be prepared: ${pi.ok ? "" : pi.error}` }, { status: 500 });

  const sent = await sendNocEmail(admin, { to, subject: mail.subject, html: mail.html, attachments: [attachment] });
  if (!sent.ok) {
    await recordNocEvent(admin, nid, "email_failed", { actorId: actor.id, actorLabel: actor.name, ip: clientIp(req.headers), detail: { to, error: sent.error, blocked: !!sent.blocked } });
    return NextResponse.json({ error: sent.error }, { status: sent.blocked ? 403 : 502 });
  }
  const now = new Date().toISOString();
  await admin.from("noc_requests").update({ status: "sent", sent_at: b.noc.sent_at ?? now, sent_to: to, updated_at: now }).eq("id", nid).in("status", ["draft", "sent"]);
  await recordNocEvent(admin, nid, "emailed", { actorId: actor.id, actorLabel: actor.name, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent"), detail: { to, invoice_number: inv?.invoice_number, attached: attachment.filename, link_reference: b.noc.public_token.slice(-4) } });
  if (b.noc.lead_id) await logEmailActivity(admin, { leadId: b.noc.lead_id, subject: mail.subject, description: `NOC ${b.reference} offer sent to ${to} with proforma ${inv?.invoice_number}`, createdBy: actor.id });
  return NextResponse.json({ data: { sent: true, to, link: prep.link } });
}
