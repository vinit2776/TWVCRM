import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma } from "@/lib/send-proforma";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { logAudit } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

export const maxDuration = 30;

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
 * POST /api/billing-statements/[id]/reissue-payment-link
 *
 * Re-issues a fresh Razorpay payment link for a statement whose previous link
 * has expired or been lost. Flow:
 *   1. Cancel the old Razorpay link (best-effort — does not fail if already expired).
 *   2. Create a new link with a timestamp-suffixed reference_id to avoid Razorpay
 *      duplicate-reference collisions on the same statement ref.
 *   3. Persist the new link_id + short_url on the billing_statement row.
 *   4a. proforma_first: dispatchProforma() sees the new link already stored and
 *       reuses it — regenerates the PI PDF with the new QR code and re-emails.
 *   4b. gst_direct with existing GST invoice: emails the existing PDF with the
 *       new payment link highlighted in the email body (no new invoice number).
 *
 * The webhook (payment_link.paid) continues to match by razorpay_payment_link_id,
 * so payment on the new link auto-marks the statement paid exactly as before.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const additionalCc: string[] = Array.isArray(body.cc) ? (body.cc as string[]).filter(Boolean) : [];

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin, manager, or accounts access required" }, { status: 403 });
  }

  const admin = await createAdminClient();

  const { data: stmt } = await admin
    .from("billing_statements")
    .select(`
      id, status, voided_at, payment_status, statement_number,
      razorpay_payment_link_id, razorpay_payment_link_url,
      gst_invoice_number, gst_invoice_path, total_amount,
      period_start, period_end, due_date, statement_type,
      contract_id,
      contract:contracts!billing_statements_contract_id_fkey(
        contract_number, billing_mode,
        lead:leads!contracts_lead_id_fkey(
          first_name, last_name, company, email, phone, mobile
        )
      )
    `)
    .eq("id", id)
    .single();

  if (!stmt) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (stmt.voided_at) return NextResponse.json({ error: "Statement is voided" }, { status: 400 });
  if (!["finalized", "exported"].includes(stmt.status as string)) {
    return NextResponse.json({ error: "Statement must be finalized before re-issuing a payment link" }, { status: 400 });
  }
  if (stmt.payment_status === "paid") {
    return NextResponse.json({ error: "Statement is already fully paid" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = stmt.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;
  const billingMode = (contract?.billing_mode as string | null) || "proforma_first";
  // Defensive rupee-rounding — total_amount should already be a whole rupee
  // (computeGstAndRounding always rounds it), but this guards against any
  // stale/unrounded value ever landing on the row.
  const totalAmount = Math.round(Number(stmt.total_amount || 0));

  const appSettings = await getCachedSettings(admin, [
    "razorpay_key_id",
    "razorpay_key_secret",
    "razorpay_enabled",
    "upi_id",
  ]);
  const rzpKeyId = appSettings["razorpay_key_id"];
  const rzpKeySecret = appSettings["razorpay_key_secret"];
  const rzpEnabled = appSettings["razorpay_enabled"] === "true";
  const upiId = appSettings["upi_id"] ?? undefined;

  const oldLinkId = stmt.razorpay_payment_link_id as string | null;

  // Cancel the old link — best-effort, don't fail the whole request if this errors.
  if (oldLinkId && rzpEnabled && rzpKeyId && rzpKeySecret) {
    try {
      const auth = Buffer.from(`${rzpKeyId}:${rzpKeySecret}`).toString("base64");
      await withTimeout(
        fetch(`https://api.razorpay.com/v1/payment_links/${oldLinkId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
        }),
        RAZORPAY_TIMEOUT_MS,
        "Razorpay cancel old link",
      );
    } catch (err) {
      console.warn("[reissue-payment-link] Could not cancel old link (non-fatal):", err);
    }
  }

  // Create the new Razorpay link with a timestamp suffix to avoid reference_id collision.
  let newLinkId: string | null = null;
  let newLinkUrl: string | null = null;

  if (rzpEnabled && rzpKeyId && rzpKeySecret && totalAmount > 0) {
    try {
      const auth = Buffer.from(`${rzpKeyId}:${rzpKeySecret}`).toString("base64");
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
      const customerName = lead
        ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
        : "Customer";
      const customerEmail = lead?.email as string | null;
      const customerPhone = (lead?.phone || lead?.mobile) as string | null;
      const stmtRef = (stmt.statement_number as string) || id.slice(0, 8);
      const contractNumber = contract?.contract_number || "";

      // Use a timestamp suffix so this never collides with the original reference_id
      // (which was `${stmtRef}-proforma`).
      const refId = `${stmtRef.replace(/[^a-zA-Z0-9_-]/g, "-")}-ri${Date.now()}`;
      const description = billingMode === "gst_direct" && stmt.gst_invoice_number
        ? `Invoice ${stmt.gst_invoice_number} — ${contractNumber} — The WorkVilla`
        : `Proforma ${stmtRef} — ${contractNumber} — The WorkVilla`;

      const payload: Record<string, unknown> = {
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        description,
        reference_id: refId,
        expire_by: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60,
        notify: { sms: !!customerPhone, email: !!customerEmail },
        reminder_enable: true,
        notes: {
          statement_id: id,
          contract_number: contractNumber,
          proforma: "true",
          reissued: "true",
        },
        callback_url: `${appUrl}/billing`,
        callback_method: "get",
      };

      if (customerName || customerEmail || customerPhone) {
        payload.customer = {} as Record<string, string>;
        if (customerName) (payload.customer as Record<string, string>).name = customerName;
        if (customerEmail) (payload.customer as Record<string, string>).email = customerEmail;
        if (customerPhone) (payload.customer as Record<string, string>).contact = (customerPhone as string).replace(/\s/g, "");
      }

      const rzpRes = await withTimeout(
        fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        RAZORPAY_TIMEOUT_MS,
        "Razorpay create reissued link",
      );

      if (rzpRes.ok) {
        const linkData = await rzpRes.json();
        newLinkId = linkData.id;
        newLinkUrl = linkData.short_url;
      } else {
        const errBody = await rzpRes.json().catch(() => ({})) as { error?: { description?: string } };
        console.error("[reissue-payment-link] Razorpay link creation failed:", JSON.stringify(errBody));
      }
    } catch (err) {
      console.error("[reissue-payment-link] Razorpay error:", err);
    }
  }

  // Persist the new link on the statement so dispatchProforma reuses it
  // and so the webhook can match it when the customer pays.
  await admin
    .from("billing_statements")
    .update({
      razorpay_payment_link_id: newLinkId,
      razorpay_payment_link_url: newLinkUrl,
    })
    .eq("id", id);

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      trigger: { old: null, new: "reissue_payment_link" },
      razorpay_payment_link_id: { old: oldLinkId, new: newLinkId },
    },
  });

  // ── proforma_first: dispatchProforma sees the stored new link and reuses it.
  // It regenerates the PI PDF with the fresh QR code and re-emails the customer.
  if (billingMode !== "gst_direct" || !stmt.gst_invoice_number) {
    const result = await dispatchProforma(admin, id, dbUser.id, additionalCc);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Payment link created but email dispatch failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      razorpayLinkUrl: result.razorpayLinkUrl,
      emailedTo: result.emailedTo,
    });
  }

  // ── gst_direct with existing GST invoice: email the existing PDF with the
  // new payment link in the email body. Do NOT regenerate the invoice number.
  const customerEmail = lead?.email as string | null;
  const contractNumber = contract?.contract_number || "";
  const invoiceNum = stmt.gst_invoice_number as string;
  const customerName =
    lead?.company ||
    `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() ||
    "Customer";

  let emailedTo: string | null = null;

  if (customerEmail) {
    try {
      const emailAttachments: Array<{ filename: string; content: Buffer; contentType: "application/pdf" }> = [];

      // Attach the existing GST invoice PDF if available
      if (stmt.gst_invoice_path) {
        const { data: fileBlob } = await admin.storage
          .from("crm-documents")
          .download(stmt.gst_invoice_path as string);
        if (fileBlob) {
          const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
          emailAttachments.push({
            filename: `GST-${invoiceNum.replace(/\//g, "-")}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          });
        }
      }

      const dueDateStr = stmt.due_date
        ? new Date((stmt.due_date as string) + "T00:00:00").toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : null;

      const paymentOptionsHtml = `
        <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
          ${upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${upiId}</td></tr>` : ""}
          ${newLinkUrl ? `<tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${newLinkUrl}" style="color:#015E65;font-weight:bold;">${newLinkUrl}</a></td></tr>` : ""}
        </table>
      `;

      const emailHtml = `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Updated Payment Link</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">We've generated a fresh payment link for your invoice. The previous link has been cancelled.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
              <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNum}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contractNumber}</td></tr>
              ${dueDateStr ? `<tr><td style="padding:6px 0;color:#666;">Due By</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${dueDateStr}</td></tr>` : ""}
              <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td></tr>
            </table>
            ${paymentOptionsHtml}
            ${newLinkUrl ? `
            <div style="text-align:center;margin:24px 0;">
              <a href="${newLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
            </div>` : ""}
            <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [customerEmail],
        cc: additionalCc.length > 0 ? additionalCc : undefined,
        bcc: "billing@theworkvilla.com",
        subject: `Updated Payment Link — Invoice ${invoiceNum} — ${contractNumber} — The WorkVilla`,
        html: emailHtml,
        attachments: emailAttachments,
      });

      emailedTo = customerEmail;
    } catch (err) {
      console.error("[reissue-payment-link] gst_direct email failed:", err);
    }
  }

  return NextResponse.json({
    ok: true,
    razorpayLinkUrl: newLinkUrl,
    emailedTo,
  });
}
