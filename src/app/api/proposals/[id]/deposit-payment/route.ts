import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * POST /api/proposals/[id]/deposit-payment
 * Records a manually-verified deposit payment (bank transfer).
 * Accepts multipart/form-data with:
 *   - amount       (required) numeric string
 *   - reference    (optional) UTR / transaction ID
 *   - notes        (optional) free text
 *   - payment_proof (optional) image or PDF file — uploaded to crm-documents storage
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only admin / manager / accounts can record manual payments
  const { data: actor } = await supabase
    .from("users")
    .select("id, full_name, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "accounts"];
  if (!actor || !ALLOWED_ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "Not authorised to record manual payments" }, { status: 403 });
  }

  // Parse multipart form
  const formData = await request.formData();
  const amountRaw = formData.get("amount") as string | null;
  const reference = (formData.get("reference") as string | null)?.trim() || null;
  const notes = (formData.get("notes") as string | null)?.trim() || null;
  const proofFile = formData.get("payment_proof") as File | null;
  const shortfallApproved = formData.get("shortfall_approved") === "true";

  const amount = parseFloat(amountRaw || "");
  if (!amountRaw || isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valid payment amount is required" }, { status: 400 });
  }

  // Fetch proposal + lead
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, email)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (proposal.deposit_payment_status === "paid") {
    return NextResponse.json({ error: "Deposit is already marked as paid" }, { status: 400 });
  }

  if (proposal.deposit_payment_status === "not_required") {
    return NextResponse.json({ error: "No deposit required for this proposal" }, { status: 400 });
  }

  // Shortfall tolerance check — expected deposit amount (pre-GST)
  const expectedAmount = Number(proposal.security_deposit_amount || 0);
  let shortfallApprovedById: string | null = null;

  if (expectedAmount > 0 && amount < expectedAmount) {
    const shortfallPct = (expectedAmount - amount) / expectedAmount; // e.g. 0.048 for 4.8%

    if (shortfallPct > 0.10) {
      // More than 10% short — hard block
      const shortfallAmt = (expectedAmount - amount).toLocaleString("en-IN");
      return NextResponse.json(
        { error: `Amount is more than 10% below the expected deposit of ₹${expectedAmount.toLocaleString("en-IN")} (shortfall ₹${shortfallAmt}). Cannot record.` },
        { status: 400 }
      );
    }

    // Within 10% shortfall — requires explicit approval from admin or manager only
    const SHORTFALL_APPROVER_ROLES = ["admin", "manager"];
    if (!SHORTFALL_APPROVER_ROLES.includes(actor.role)) {
      return NextResponse.json(
        { error: "Only an admin or manager can approve a deposit shortfall. Please record the exact expected amount or ask a manager." },
        { status: 403 }
      );
    }

    if (!shortfallApproved) {
      return NextResponse.json(
        { error: "Shortfall approval is required. Check the approval box before submitting." },
        { status: 400 }
      );
    }

    shortfallApprovedById = actor.id;
  }

  // Upload proof to Supabase Storage if provided
  let screenshotUrl: string | null = null;
  if (proofFile && proofFile.size > 0) {
    const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `proposals/${id}/deposit-proof-${Date.now()}.${ext}`;
    const buffer = Buffer.from(await proofFile.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(path, buffer, {
        contentType: proofFile.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error("[deposit-payment] storage upload error:", uploadError);
      // Non-fatal: proceed without screenshot
    } else {
      const { data: urlData } = supabase.storage
        .from("crm-documents")
        .getPublicUrl(path);
      screenshotUrl = urlData?.publicUrl || null;
      // Fall back to signed URL if bucket is private
      if (!screenshotUrl) {
        const { data: signed } = await supabase.storage
          .from("crm-documents")
          .createSignedUrl(path, 60 * 60 * 24 * 365); // 1 year
        screenshotUrl = signed?.signedUrl || null;
      }
    }
  }

  // Update proposal
  const receivedAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("proposals")
    .update({
      deposit_payment_status: "paid",
      deposit_payment_amount: amount,
      deposit_payment_reference: reference,
      deposit_payment_received_at: receivedAt,
      deposit_payment_screenshot_url: screenshotUrl,
      ...(shortfallApprovedById ? { deposit_shortfall_approved_by: shortfallApprovedById } : {}),
    })
    .eq("id", id);

  if (updateError) {
    console.error("[deposit-payment] update error:", updateError);
    return NextResponse.json({ error: "Failed to update proposal" }, { status: 500 });
  }

  // Send confirmation email to customer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerEmail = lead?.email;
  const customerName = lead
    ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
    : "Customer";

  if (customerEmail) {
    const formattedDate = new Date(receivedAt).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "long", day: "numeric",
    });

    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject: `Security Deposit Received — ${proposal.proposal_number} — The WorkVilla`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Payment Confirmation</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">We have received your security deposit payment for proposal <strong>${proposal.proposal_number}</strong>. Thank you!</p>

            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0;">
              <p style="color:#166534;font-size:13px;font-weight:700;margin:0 0 12px;">✅ PAYMENT RECEIVED</p>
              <table style="border-collapse:collapse;width:100%;">
                <tr><td style="padding:6px 0;color:#555;font-size:13px;width:45%;">Proposal</td><td style="padding:6px 0;font-weight:bold;color:#015E65;font-size:13px;">${proposal.proposal_number}</td></tr>
                <tr><td style="padding:6px 0;color:#555;font-size:13px;">Amount Received</td><td style="padding:6px 0;font-weight:bold;color:#166534;font-size:16px;">₹${amount.toLocaleString("en-IN")}</td></tr>
                <tr><td style="padding:6px 0;color:#555;font-size:13px;">Date</td><td style="padding:6px 0;color:#333;font-size:13px;">${formattedDate}</td></tr>
                ${reference ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Reference / UTR</td><td style="padding:6px 0;font-family:monospace;color:#333;font-size:13px;">${reference}</td></tr>` : ""}
              </table>
            </div>

            <p style="color:#333;font-size:14px;">Your booking is now confirmed. Our team will reach out to you shortly with the next steps and your formal booking confirmation letter.</p>

            <p style="color:#333;font-size:14px;">If you have any questions, please contact us:</p>
            <ul style="color:#333;font-size:13px;">
              <li>Email: <a href="mailto:contact@theworkvilla.com" style="color:#015E65;">contact@theworkvilla.com</a></li>
              <li>Phone: <strong>+91 97910 97900</strong></li>
            </ul>

            <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034</p>
          </div>
        </div>
      `,
    }).catch(console.error);
  }

  return NextResponse.json({
    message: "Deposit payment recorded successfully",
    screenshot_url: screenshotUrl,
    confirmation_email_sent: !!customerEmail,
  });
}
