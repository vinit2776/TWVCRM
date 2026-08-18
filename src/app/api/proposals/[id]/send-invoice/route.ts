import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { messaging } from "@/lib/whatsapp";
import { logWhatsAppActivity } from "@/lib/audit";
import { calcGst } from "@/lib/tax";
import { dispatchProforma } from "@/lib/send-proforma";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";

/**
 * POST /api/proposals/[id]/send-invoice
 *
 * Generates a prorated GST invoice for the first month.
 *
 * Modes:
 *   - { occupation_start_date, items_override?, preview: true } → returns
 *     computed figures + HTML, does NOT send email, does NOT persist the
 *     occupation date, does NOT create a billing_statements row or a
 *     Razorpay link.
 *   - { occupation_start_date, items_override?, additionalCc? } → creates a
 *     billing_statements row (proposal_id set, no contract yet) and
 *     dispatches it through the same shared proforma pipeline every contract
 *     invoice uses (Razorpay link, PDF, email to customer +
 *     lead.billing_emails + additionalCc, audit log). This is what makes the
 *     PI show up in Accounts Receivable and, once paid, the Tally Inbox.
 *     Persists the occupation date, sends WhatsApp. Can be called again
 *     (revise & resend) — if a prior unpaid statement for this proposal
 *     exists, its Razorpay link is cancelled and it is marked voided
 *     (voided_statement_id points the new row back at it) before the new one
 *     is created, so the customer never holds two live payment links.
 *     Blocked if the prior statement already has payments recorded.
 *
 * items_override — optional [{ description, qty, unit_price }], lets staff
 * hand-edit the prorated line items (amount override, added/removed lines)
 * instead of the auto-computed proposal.items × prorationFactor. amount is
 * always recomputed server-side as qty × unit_price, never trusted from the
 * client.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();

  const body = await request.json();
  const { occupation_start_date, preview, additionalCc, items_override } = body;
  const isPreview = preview === true;

  if (!occupation_start_date) {
    return NextResponse.json({ error: "Occupation start date is required" }, { status: 400 });
  }

  let overrideItems: { description: string; qty: number; unit_price: number }[] | null = null;
  if (items_override !== undefined) {
    if (!Array.isArray(items_override) || items_override.length === 0) {
      return NextResponse.json({ error: "items_override must be a non-empty array" }, { status: 400 });
    }
    overrideItems = items_override.map((raw: { description?: unknown; qty?: unknown; unit_price?: unknown }) => ({
      description: String(raw.description ?? "").trim(),
      qty: Number(raw.qty),
      unit_price: Number(raw.unit_price),
    }));
    const invalid = overrideItems.find(
      (i) => !i.description || !Number.isFinite(i.qty) || i.qty <= 0 || !Number.isFinite(i.unit_price) || i.unit_price < 0
    );
    if (invalid) {
      return NextResponse.json({ error: "Each override line item needs a description, a positive quantity, and a non-negative rate" }, { status: 400 });
    }
  }

  // Fetch proposal with lead
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile, state, gst_number)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const depositRequired = Number(proposal.security_deposit_months || 0) > 0;
  if (depositRequired && proposal.deposit_payment_status !== "paid") {
    return NextResponse.json({ error: "Security deposit must be paid before sending the invoice" }, { status: 400 });
  }

  // Allow resend: status may be "sent" (first time) or anything post-acceptance
  if (!["sent", "viewed", "accepted"].includes(proposal.status)) {
    return NextResponse.json({ error: "Proposal must be shared with the customer first" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const customerEmail = lead?.email;

  // ── Proration calculation ──────────────────────────────────────────────────
  const startDate = new Date(occupation_start_date + "T00:00:00Z");
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  const dayOfMonth = startDate.getUTCDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;
  const prorationFactor = daysRemaining / daysInMonth;

  const taxPercentage = Number(proposal.tax_percentage || 18);

  // Prorated line items — same shape billing.ts uses (qty/unit_price + the
  // monthly_rate/days_used/days_in_month trio that withProrationBreakdown()
  // turns into the "Monthly Rate: ... | Prorated Rate: ..." sub-line on the
  // PDF). When staff supply items_override, those replace the auto-prorated
  // lines wholesale — amount is always qty × unit_price, recomputed here
  // rather than trusted from the client; there's no single "monthly rate" to
  // show a breakdown against, so those fields are left off.
  const lineItems = overrideItems
    ? overrideItems.map((item) => ({
        description: item.description,
        qty: item.qty,
        unit_price: item.unit_price,
        amount: Math.round(item.qty * item.unit_price * 100) / 100,
        hsn_sac_code: resolveHsnCode("rent"),
      }))
    : (proposal.items || []).map((item: { description: string; quantity: number; unit_price: number; unit?: string }) => {
        const proratedRate = Math.round(item.unit_price * prorationFactor * 100) / 100;
        return {
          description: item.description,
          qty: item.quantity,
          unit_price: proratedRate,
          amount: Math.round(item.quantity * proratedRate * 100) / 100,
          monthly_rate: item.unit_price,
          days_used: daysRemaining,
          days_in_month: daysInMonth,
          hsn_sac_code: resolveHsnCode("rent"),
        };
      });

  const proratedSubtotal = Math.round(lineItems.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0) * 100) / 100;

  // Always intra-state Tamil Nadu — calcGst enforces CGST+SGST only (IGST=0)
  const { taxAmount, grandTotal: totalAmount } = calcGst(proratedSubtotal, taxPercentage);

  const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${daysInMonth}`;
  const periodLabel = startDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "long", year: "numeric" });
  const startLabel = startDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  const endLabel = new Date(periodEnd + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

  // Preview mode — return computed figures + a lightweight HTML preview.
  // No DB writes, no Razorpay link, no email/WhatsApp. The final invoice
  // number is assigned by the DB trigger when the statement is inserted on
  // send, so preview cannot show it in advance.
  if (isPreview) {
    const payBlock = `<div style="text-align:center;margin:24px 0;padding:14px;border:1px dashed #015E65;border-radius:8px;background:#f0faf5;">
             <p style="color:#015E65;font-size:13px;margin:0;font-style:italic;">A Razorpay payment link will be generated and inserted here when you click <strong>Send Invoice</strong>.</p>
           </div>`;
    const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Proforma Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Please find attached your proforma invoice for the period <strong>${startLabel}</strong> to <strong>${endLabel}</strong>.</p>
        ${!overrideItems && prorationFactor < 1 ? `
        <div style="background:#f0faf5;border-left:4px solid #015E65;padding:14px 18px;margin:16px 0;border-radius:0 6px 6px 0;">
          <p style="color:#015E65;font-size:13px;font-weight:600;margin:0 0 8px;">About this invoice</p>
          <p style="color:#333;font-size:13px;margin:0;">Prorated amount: Rs. ${Number(proposal.subtotal || proposal.total_amount || 0).toLocaleString("en-IN")} × ${daysRemaining}/${daysInMonth} = <strong>Rs. ${proratedSubtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong> + GST</p>
        </div>` : ""}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f7f8fa;border-radius:6px;">
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Proposal Ref.</td><td style="padding:10px 16px;">${proposal.proposal_number}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Subtotal${prorationFactor < 1 ? " (prorated)" : ""}</td><td style="padding:10px 16px;">Rs. ${proratedSubtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">GST @${taxPercentage}%</td><td style="padding:10px 16px;">Rs. ${taxAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          <tr style="background:#015E65;"><td style="padding:10px 16px;color:white;font-weight:600;">Amount Payable</td><td style="padding:10px 16px;color:white;font-weight:700;font-size:16px;">Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
        </table>
        ${payBlock}
        <p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">Bank Transfer</p>
        <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account Name</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
          <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account No.</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
          <tr><td style="padding:8px 16px;color:#666;">IFSC Code</td><td style="padding:8px 16px;color:#333;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
        </table>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>`;

    return NextResponse.json({
      preview: true,
      subject: `Proforma Invoice — ${proposal.proposal_number} — The WorkVilla`,
      html,
      to: customerEmail ? [customerEmail] : [],
      invoiceNumber: null, // assigned by the DB trigger when the statement is created on send
      items: lineItems.map((i: { description: string; qty: number; unit_price: number; amount: number }) => ({
        description: i.description, qty: i.qty, unit_price: i.unit_price, amount: i.amount,
      })),
      proratedSubtotal,
      taxAmount,
      totalAmount,
      daysRemaining,
      daysInMonth,
      prorationFactor: Math.round(prorationFactor * 100) / 100,
      periodLabel,
      startLabel,
      endLabel,
      razorpayUrl: null,
      is_revise: !!proposal.occupation_start_date,
      previous_occupation_start_date: proposal.occupation_start_date || null,
    });
  }

  // ── Send mode: create the billing_statements row, dispatch through the ────
  // shared proforma pipeline (Razorpay link, PDF, email, audit, AR eligibility) ─
  const adminSupabase = createAdminClient();

  // Revise & resend: if an earlier pro-rata statement for this proposal is
  // still unpaid, cancel its Razorpay link and void it before creating the
  // replacement, instead of leaving the old link live alongside a new one.
  // Proposal-owned statements (proposal_id only, no contract/booking/lead)
  // don't go through the shared /billing-statements/[id]/void endpoint —
  // its replacement-draft step only fires for contract/booking/lead-owned
  // statements — so this is handled inline here instead.
  const { data: priorStatement } = await adminSupabase
    .from("billing_statements")
    .select("id, razorpay_payment_link_id, notes")
    .eq("proposal_id", id)
    .eq("created_via", "proposal_pi")
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let voidedStatementId: string | null = null;

  if (priorStatement) {
    const { data: priorPayments } = await adminSupabase
      .from("billing_payments")
      .select("id")
      .eq("billing_statement_id", priorStatement.id);

    if (priorPayments && priorPayments.length > 0) {
      return NextResponse.json(
        { error: "The previous pro-rata invoice already has a payment recorded against it and can't be revised. Void it manually first if it needs correcting." },
        { status: 409 }
      );
    }

    const linkId = priorStatement.razorpay_payment_link_id as string | null;
    if (linkId) {
      try {
        const { data: rzpSettings } = await adminSupabase
          .from("app_settings")
          .select("key, value")
          .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
        const rzp: Record<string, string> = {};
        (rzpSettings || []).forEach((s: { key: string; value: string }) => { rzp[s.key] = s.value; });

        if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
          const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
          const cancelRes = await fetch(
            `https://api.razorpay.com/v1/payment_links/${linkId}/cancel`,
            { method: "POST", headers: { Authorization: `Basic ${auth}` } }
          );
          if (!cancelRes.ok) {
            console.warn("[send-invoice] Razorpay link cancel failed (non-fatal):", await cancelRes.text());
          }
        }
      } catch (e) {
        console.warn("[send-invoice] Razorpay cancel error (non-fatal):", e);
      }
    }

    await adminSupabase
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: dbUser?.id || null,
        void_reason: "Revised before payment",
        notes: [priorStatement.notes, `--- VOIDED — revised before payment ---`].filter(Boolean).join("\n"),
      })
      .eq("id", priorStatement.id);

    voidedStatementId = priorStatement.id;
  }

  const { data: newStatement, error: insertErr } = await adminSupabase
    .from("billing_statements")
    .insert({
      proposal_id: id,
      contract_id: null,
      statement_type: "rent",
      created_via: "proposal_pi",
      status: "finalized",
      payment_status: "unpaid",
      handoff_state: "pi_awaiting_payment",
      period_start: occupation_start_date,
      period_end: periodEnd,
      fixed_amount: proratedSubtotal,
      tax_percentage: taxPercentage,
      line_items: [{ type: "rent", label: "Proposal Items", items: lineItems, subtotal: proratedSubtotal }],
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      created_by: dbUser?.id || null,
      voided_statement_id: voidedStatementId,
    })
    .select("id")
    .single();

  if (insertErr || !newStatement) {
    return NextResponse.json({ error: insertErr?.message || "Failed to create invoice statement" }, { status: 500 });
  }

  const cc: string[] = Array.isArray(additionalCc) ? additionalCc.filter(Boolean) : [];
  const dispatchResult = await dispatchProforma(adminSupabase, newStatement.id, dbUser?.id || null, cc);

  if (!dispatchResult.success) {
    return NextResponse.json({ error: dispatchResult.error || "Failed to dispatch invoice" }, { status: 500 });
  }

  await supabase.from("proposals").update({ occupation_start_date }).eq("id", id);

  // WhatsApp — fire to phone if available (fire-and-forget), unchanged from before.
  const customerPhone = lead?.phone || lead?.mobile;
  if (customerPhone && dispatchResult.razorpayLinkUrl) {
    const amountFormatted = totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 });

    // gst_invoice_doc's body already carries the invoice number, amount and
    // payment link, so the old proposal_invoice text send was a duplicate — and
    // that template was never registered in MSG91, so it always failed while
    // this document send succeeded.
    if (dispatchResult.pdfStoragePath) {
      const { data: signedUrlData } = await adminSupabase.storage
        .from("crm-documents")
        .createSignedUrl(dispatchResult.pdfStoragePath, 365 * 24 * 3600);
      const invoicePdfUrl = signedUrlData?.signedUrl ?? null;
      if (invoicePdfUrl) {
        messaging.invoiceDocument(
          customerPhone,
          customerName,
          dispatchResult.proformaRef,
          amountFormatted,
          dispatchResult.razorpayLinkUrl,
          invoicePdfUrl,
          { type: "proposal", id }
        ).catch((e: unknown) => console.error("[messaging] invoice WA doc failed:", e));

        if (proposal.lead_id && dbUser?.id) {
          logWhatsAppActivity(supabase, {
            leadId: proposal.lead_id,
            subject: `Invoice ${dispatchResult.proformaRef} sent`,
            description: `Prorated proforma invoice ${dispatchResult.proformaRef} for ₹${amountFormatted} sent via WhatsApp to ${customerPhone}. Payment link: ${dispatchResult.razorpayLinkUrl}`,
            createdBy: dbUser.id,
          });
        }
      }
    } else {
      // Without a PDF we cannot send this template at all — it has a document
      // header. Log it rather than failing silently.
      console.warn(
        `[send-invoice] No invoice PDF for ${dispatchResult.proformaRef} — WhatsApp invoice skipped.`
      );
    }
  }

  return NextResponse.json({
    success: true,
    invoiceNumber: dispatchResult.proformaRef,
    proratedSubtotal,
    taxAmount,
    totalAmount,
    daysRemaining,
    daysInMonth,
    prorationFactor: Math.round(prorationFactor * 100) / 100,
    razorpayUrl: dispatchResult.razorpayLinkUrl,
    sent_to: dispatchResult.emailedTo,
    is_revise: !!proposal.occupation_start_date,
  });
}

export const maxDuration = 30;
