import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { routeGstGenerationToTally } from "@/lib/tally/enqueue";
import QRCode from "qrcode";
import { z } from "zod";

export const maxDuration = 30;

const BodySchema = z.object({
  reason: z.string().min(5, "Reason must be at least 5 characters"),
  sendEmail: z.boolean().default(true),
});

const RAZORPAY_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * POST /api/billing-statements/[id]/convert-to-gst-early
 *
 * Overrides the standard proforma-first flow: cancels the existing PI (proforma),
 * issues a GST tax invoice immediately (before payment), and refreshes the
 * Razorpay payment link to reference the new invoice.
 *
 * Guards:
 *   - Admin or manager only
 *   - Statement must be finalized, unpaid/partially paid, no existing GST invoice
 *   - PI must not already have been cancelled via this action
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or manager can issue an early GST invoice override" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { reason, sendEmail } = parsed.data;

  const adminSupabase = await createAdminClient();

  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, next_billing_date, billing_cycle, location_id, items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  // Guards
  if (statement.status !== "finalized") {
    return NextResponse.json({ error: "Statement must be finalized to use this override" }, { status: 400 });
  }
  if (statement.payment_status === "paid") {
    return NextResponse.json({ error: "Statement is already fully paid — use the standard GST invoice flow" }, { status: 400 });
  }
  if (statement.gst_invoice_number) {
    return NextResponse.json({ error: "A GST invoice has already been issued for this statement", invoiceNumber: statement.gst_invoice_number }, { status: 409 });
  }
  if (statement.pi_cancelled_at) {
    return NextResponse.json({ error: "PI has already been cancelled via an earlier override" }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;

  if (!contract) {
    return NextResponse.json({ error: "No contract linked to this statement" }, { status: 400 });
  }

  // ── Fetch Razorpay credentials ──────────────────────────────────────────
  const { data: rzpRows } = await adminSupabase
    .from("app_settings").select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp = (rzpRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => {
    m[r.key] = r.value; return m;
  }, {});
  const rzpEnabled = rzp.razorpay_enabled === "true" && !!rzp.razorpay_key_id && !!rzp.razorpay_key_secret;
  const rzpAuth = rzpEnabled
    ? Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64")
    : null;

  // ── Cancel existing Razorpay payment link ───────────────────────────────
  const existingLinkId = statement.razorpay_payment_link_id as string | null;
  if (existingLinkId && rzpAuth) {
    try {
      await withTimeout(
        fetch(`https://api.razorpay.com/v1/payment_links/${existingLinkId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Basic ${rzpAuth}` },
        }),
        RAZORPAY_TIMEOUT_MS,
        "Razorpay cancel link",
      );
    } catch (err) {
      console.error("[convert-to-gst-early] Razorpay cancel failed (non-blocking):", err);
    }
  }

  // ── Tally routing gate (surgical swap point #3: early PI → GST override) ──
  // The old PI link is now cancelled. When Tally GST issuance is active, hand
  // the GST invoice to Tally rather than minting a CRM number + new Razorpay
  // link + email here. We still record the PI-cancellation markers so the
  // override is audited; the bridge mints the number and dispatchTallyInvoice
  // (unpaid gst_direct path) creates the fresh Razorpay link, sends the PDF,
  // and enrols dunning once the invoice is issued.
  const tallyNow = new Date();
  const tallyNowIso = tallyNow.toISOString();
  const tallyNowYmd = tallyNowIso.slice(0, 10);
  if (await routeGstGenerationToTally(id)) {
    await adminSupabase.from("billing_statements").update({
      pi_cancelled_at: tallyNowIso,
      pi_cancelled_by: dbUser.id,
      pi_override_reason: reason,
      razorpay_payment_link_id: null,
      razorpay_payment_link_url: null,
      due_date: tallyNowYmd,
      notes: [
        statement.notes,
        `PI ${statement.statement_number} cancelled ${tallyNowYmd} — early GST invoice routed to Tally. Reason: ${reason}`,
      ].filter(Boolean).join("\n"),
    }).eq("id", id);

    logAudit(adminSupabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        pi_cancelled_at: { old: null, new: tallyNowIso },
        issuance_channel: { old: "crm", new: "tally" },
        razorpay_payment_link_id: { old: existingLinkId, new: null },
        override_reason: { old: null, new: reason },
      },
    });

    return NextResponse.json({
      success: true,
      routedToTally: true,
      invoiceNumber: null,    // assigned by Tally, mirrored back on ack
      totalAmount: 0,
      newPaymentLink: null,   // created by dispatchTallyInvoice after issuance
      emailedTo: null,
      emailSkipped: true,
    });
  }

  // ── Recalculate totals ──────────────────────────────────────────────────
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s: number, c: { total: number }) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);
  const isInterstate = false;
  const igst = 0;
  const cgst = Math.round(subtotal * (taxPercentage / 200));
  const sgst = Math.round(subtotal * (taxPercentage / 200));
  const taxAmount = cgst + sgst;
  const totalAmount = subtotal + taxAmount;

  // ── Generate GST invoice number ─────────────────────────────────────────
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyEnd = fyStart + 1;
  const fyPrefix = `TWV/INV/${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}/`;

  const { count: existingCount } = await adminSupabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .like("gst_invoice_number", `${fyPrefix}%`);

  const seqNum = (existingCount || 0) + 1;
  const invoiceNumber = `${fyPrefix}${String(seqNum).padStart(4, "0")}`;

  // GST invoice date = today (the day of issue, not period_start)
  const todayYmd = now.toISOString().slice(0, 10);

  // ── Fetch UPI ID ─────────────────────────────────────────────────────────
  let upiId: string | undefined;
  try {
    const { data: settings } = await adminSupabase.from("app_settings").select("key, value").eq("key", "upi_id");
    const map: Record<string, string> = {};
    (settings || []).forEach((s: { key: string; value: string }) => { map[s.key] = s.value; });
    upiId = map.upi_id;
  } catch { /* non-blocking */ }

  // ── Create new Razorpay payment link (referencing GST invoice) ──────────
  let newRzpLinkId: string | null = null;
  let newRzpLinkUrl: string | null = null;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";
  const customerEmail = lead?.email as string | undefined;
  const customerPhone = (lead?.mobile || lead?.phone || "") as string;

  if (rzpAuth) {
    try {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
      const refId = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`;

      const payload: Record<string, unknown> = {
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        description: `Tax Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
        reference_id: refId,
        expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        notify: { sms: !!customerPhone, email: !!customerEmail },
        reminder_enable: true,
        notes: {
          statement_id: id,
          contract_number: contract.contract_number,
          gst_invoice: invoiceNumber,
          overrides_pi: statement.statement_number,
        },
        callback_url: `${appUrl}/billing`,
        callback_method: "get",
      };
      if (customerName || customerEmail || customerPhone) {
        payload.customer = {
          ...(customerName ? { name: customerName } : {}),
          ...(customerEmail ? { email: customerEmail } : {}),
          ...(customerPhone ? { contact: customerPhone.replace(/\s/g, "") } : {}),
        };
      }

      const rzpRes = await withTimeout(
        fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${rzpAuth}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        RAZORPAY_TIMEOUT_MS,
        "Razorpay create GST link",
      );

      if (rzpRes.ok) {
        const linkData = await rzpRes.json() as { id: string; short_url: string };
        newRzpLinkId = linkData.id;
        newRzpLinkUrl = linkData.short_url;
      } else {
        console.error("[convert-to-gst-early] Razorpay new link failed:", await rzpRes.text());
      }
    } catch (err) {
      console.error("[convert-to-gst-early] Razorpay create link threw:", err);
    }
  }

  // ── Build PDF line items ─────────────────────────────────────────────────
  const lineItems: GstInvoiceData["lineItems"] = [];
  const structuredSections = (statement.line_items || []) as Array<{
    type: string; label: string; items: Record<string, unknown>[]; subtotal: number
  }>;

  if (structuredSections.length > 0) {
    for (const section of structuredSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({
          description: label || section.label,
          hsnSac: "997212",
          qty: Number(item.quantity || item.billable || 1),
          rate: Number(item.unit_price || item.rate || item.amount || 0),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else {
    if (fixedAmount > 0) {
      lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: "997212", qty: 1, rate: fixedAmount, amount: fixedAmount });
    }
    for (const charge of usageCharges) {
      lineItems.push({ description: charge.description, hsnSac: "997212", qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
    }
  }

  // ── Generate GST PDF ──────────────────────────────────────────────────────
  let razorpayQrBase64: string | undefined;
  if (newRzpLinkUrl) {
    try {
      razorpayQrBase64 = await QRCode.toDataURL(newRzpLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    } catch { /* skip QR */ }
  }
  const linkExpiryStr = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
  });

  const invoiceData: GstInvoiceData = {
    invoiceNumber,
    invoiceDate: todayYmd,
    isProforma: false,
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start as string,
    periodEnd: statement.period_end as string,
    dueDate: todayYmd,
    contractNumber: contract.contract_number,
    lineItems,
    subtotal,
    cgst,
    sgst,
    igst,
    totalAmount,
    isInterstate,
    taxPercentage,
    upiId,
    razorpayUrl: newRzpLinkUrl ?? undefined,
    razorpayQrBase64,
    razorpayExpiry: newRzpLinkUrl ? linkExpiryStr : undefined,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  const storagePath = `invoices/${invoiceNumber.replace(/\//g, "-")}.pdf`;
  const { error: uploadErr } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  if (uploadErr) console.error("[convert-to-gst-early] PDF upload failed:", uploadErr);

  // ── Send GST invoice email ────────────────────────────────────────────────
  const periodLabel = new Date((statement.period_start as string) + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", month: "short", year: "numeric",
  });
  const { data: ccUsers } = await adminSupabase.from("users").select("email")
    .in("role", ["admin", "accounts"]).eq("is_active", true);
  const ccEmails = (ccUsers || []).map((u: { email: string }) => u.email).filter(Boolean);

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Please find attached your GST tax invoice for <strong>${periodLabel}</strong>. Kindly make payment at your earliest convenience.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contract.contract_number}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Invoice Date</td><td style="padding:6px 0;">${new Date(todayYmd + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td></tr>
        </table>
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 16px;margin:16px 0;font-size:12px;color:#5d4037;">
          Note: This replaces our earlier Proforma Invoice ${statement.statement_number} which has been cancelled. Please use this tax invoice for your records.
        </div>
        ${newRzpLinkUrl ? `
        <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
          ${upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${upiId}</td></tr>` : ""}
          <tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${newRzpLinkUrl}" style="color:#015E65;font-weight:bold;">${newRzpLinkUrl}</a></td></tr>
        </table>
        <div style="text-align:center;margin:24px 0;">
          <a href="${newRzpLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
        </div>` : ""}
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;

  let emailedSuccessfully = false;
  const nowIso = now.toISOString();

  if (sendEmail && customerEmail) {
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [customerEmail],
        cc: ccEmails.length > 0 ? ccEmails : undefined,
        subject: `Tax Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
        html: emailHtml,
        attachments: !uploadErr
          ? [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
          : undefined,
      });
      emailedSuccessfully = true;
    } catch (err) {
      console.error("[convert-to-gst-early] Email failed:", err);
    }
  }

  // ── Persist all changes ───────────────────────────────────────────────────
  await adminSupabase.from("billing_statements").update({
    // GST invoice fields
    gst_invoice_number: invoiceNumber,
    gst_invoice_path: uploadErr ? null : storagePath,
    gst_invoice_sent_at: emailedSuccessfully ? nowIso : null,
    gst_invoice_sent_to: emailedSuccessfully ? customerEmail : null,
    gst_invoice_due_date: todayYmd,
    // PI cancellation marker
    pi_cancelled_at: nowIso,
    pi_cancelled_by: dbUser.id,
    pi_override_reason: reason,
    // New payment link
    razorpay_payment_link_id: newRzpLinkId || null,
    razorpay_payment_link_url: newRzpLinkUrl || null,
    // Update due_date to today (immediate)
    due_date: todayYmd,
    // Recalculated amounts
    subtotal,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    is_interstate: isInterstate,
    buyer_gstin: lead?.gst_number || null,
    notes: [
      statement.notes,
      `PI ${statement.statement_number} cancelled ${todayYmd} — early GST invoice issued (${invoiceNumber}). Reason: ${reason}`,
    ].filter(Boolean).join("\n"),
  }).eq("id", id);

  logAudit(adminSupabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      pi_cancelled_at: { old: null, new: nowIso },
      gst_invoice_number: { old: null, new: invoiceNumber },
      razorpay_payment_link_id: { old: existingLinkId, new: newRzpLinkId },
      due_date: { old: statement.due_date, new: todayYmd },
      override_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({
    success: true,
    invoiceNumber,
    totalAmount,
    newPaymentLink: newRzpLinkUrl,
    emailedTo: emailedSuccessfully ? customerEmail : null,
    emailSkipped: !sendEmail || !customerEmail,
  });
}
