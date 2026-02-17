import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend } from "@/lib/resend";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  // Fetch contract with lead info
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select(
      "*, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email)"
    )
    .eq("id", id)
    .single();

  if (contractError || !contract) {
    return NextResponse.json(
      { error: "Contract not found" },
      { status: 404 }
    );
  }

  // ===== Mode 1: Per-seat individual email =====
  if (body.issuance_id) {
    const { issuance_id, email } = body as {
      issuance_id: string;
      email?: string;
    };

    // Fetch the specific issuance with voucher details
    const { data: issuance, error: issuanceError } = await supabase
      .from("voucher_issuances")
      .select(
        "*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)"
      )
      .eq("id", issuance_id)
      .eq("contract_id", id)
      .single();

    if (issuanceError || !issuance) {
      return NextResponse.json(
        { error: "Issuance not found" },
        { status: 404 }
      );
    }

    const recipientEmail = email || issuance.seat_occupant_email;

    if (!recipientEmail) {
      return NextResponse.json(
        { error: "No email address provided or stored for this seat" },
        { status: 400 }
      );
    }

    const voucherCode = issuance.voucher?.voucher_code || "—";
    const validFrom = issuance.valid_from
      ? new Date(issuance.valid_from).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })
      : "—";
    const validUntil = issuance.valid_until
      ? new Date(issuance.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })
      : "—";

    try {
      await resend.emails.send({
        from: "The WorkVilla <onboarding@resend.dev>",
        to: [recipientEmail],
        subject: `Your WiFi Access Code — The WorkVilla`,
        html: buildPerSeatEmailHTML({
          recipientName: issuance.seat_occupant_email ? recipientEmail.split("@")[0] : (contract.lead?.first_name || "User"),
          voucherCode,
          validFrom,
          validUntil,
          seatNumber: issuance.seat_number,
          contractNumber: contract.contract_number,
          senderName,
        }),
      });

      // Update issuance: set emailed_at and seat_occupant_email
      const now = new Date().toISOString();
      await supabase
        .from("voucher_issuances")
        .update({
          emailed_at: now,
          seat_occupant_email: recipientEmail,
        })
        .eq("id", issuance_id);

      return NextResponse.json({
        message: `Voucher emailed to ${recipientEmail}`,
        emailed_at: now,
      });
    } catch (error) {
      console.error("Per-seat email error:", error);
      return NextResponse.json(
        { error: "Failed to send email. Check RESEND_API_KEY configuration." },
        { status: 500 }
      );
    }
  }

  // ===== Mode 2: Bulk per-seat emails =====
  if (body.per_seat === true) {
    // Fetch all active issuances with emails
    const { data: issuances, error: issuanceError } = await supabase
      .from("voucher_issuances")
      .select(
        "*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)"
      )
      .eq("contract_id", id)
      .eq("is_active", true)
      .not("seat_occupant_email", "is", null)
      .order("seat_number", { ascending: true });

    if (issuanceError) {
      return NextResponse.json({ error: issuanceError.message }, { status: 500 });
    }

    if (!issuances || issuances.length === 0) {
      return NextResponse.json(
        { error: "No active issuances with email addresses found" },
        { status: 400 }
      );
    }

    let sent = 0;
    let failed = 0;
    const details: { seat: number; email: string; status: string }[] = [];
    const now = new Date().toISOString();

    for (const issuance of issuances) {
      const email = issuance.seat_occupant_email;
      if (!email) continue;

      const voucherCode = issuance.voucher?.voucher_code || "—";
      const validFrom = issuance.valid_from
        ? new Date(issuance.valid_from).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })
        : "—";
      const validUntil = issuance.valid_until
        ? new Date(issuance.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })
        : "—";

      try {
        await resend.emails.send({
          from: "The WorkVilla <onboarding@resend.dev>",
          to: [email],
          subject: `Your WiFi Access Code — The WorkVilla`,
          html: buildPerSeatEmailHTML({
            recipientName: email.split("@")[0],
            voucherCode,
            validFrom,
            validUntil,
            seatNumber: issuance.seat_number,
            contractNumber: contract.contract_number,
            senderName,
          }),
        });

        await supabase
          .from("voucher_issuances")
          .update({ emailed_at: now })
          .eq("id", issuance.id);

        sent++;
        details.push({ seat: issuance.seat_number, email, status: "sent" });
      } catch {
        failed++;
        details.push({ seat: issuance.seat_number, email, status: "failed" });
      }
    }

    return NextResponse.json({ sent, failed, details });
  }

  // ===== Mode 3: Legacy bulk email (all codes to one set of recipients) =====
  const { recipients, terms_and_conditions } = body as {
    recipients: string[];
    terms_and_conditions?: string;
  };

  if (!recipients || recipients.length === 0) {
    return NextResponse.json(
      { error: "At least one recipient email is required" },
      { status: 400 }
    );
  }

  // Fetch active voucher issuances
  const { data: issuances, error: issuanceError } = await supabase
    .from("voucher_issuances")
    .select(
      "*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at)"
    )
    .eq("contract_id", id)
    .eq("is_active", true)
    .order("seat_number", { ascending: true });

  if (issuanceError) {
    return NextResponse.json(
      { error: issuanceError.message },
      { status: 500 }
    );
  }

  if (!issuances || issuances.length === 0) {
    return NextResponse.json(
      { error: "No vouchers have been issued for this contract" },
      { status: 400 }
    );
  }

  const voucherRows = issuances
    .map(
      (issuance) => `
        <tr>
          <td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb; text-align: center;">${issuance.seat_number}</td>
          <td style="padding: 10px 16px; color: #015E65; font-weight: bold; border-bottom: 1px solid #e5e7eb; font-family: monospace;">${issuance.voucher?.voucher_code || "—"}</td>
          <td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${issuance.valid_from ? new Date(issuance.valid_from).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }) : "—"}</td>
          <td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${issuance.valid_until ? new Date(issuance.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }) : "—"}</td>
        </tr>`
    )
    .join("");

  const termsSection = terms_and_conditions
    ? `
        <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
          <h3 style="color: #015E65; margin: 0 0 8px; font-size: 14px;">Terms &amp; Conditions</h3>
          <p style="color: #555; font-size: 13px; margin: 0; white-space: pre-line;">${terms_and_conditions}</p>
        </div>`
    : "";

  try {
    await resend.emails.send({
      from: "The WorkVilla <onboarding@resend.dev>",
      to: recipients,
      subject: `Internet Access Vouchers - Contract ${contract.contract_number}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${contract.lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">Here are your internet access voucher details for contract <strong>${contract.contract_number}</strong>.</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; border-radius: 6px; overflow: hidden;">
              <thead>
                <tr style="background: #f0faf5;">
                  <th style="padding: 10px 16px; color: #015E65; font-size: 13px; text-align: center; border-bottom: 2px solid #015E65;">Seat #</th>
                  <th style="padding: 10px 16px; color: #015E65; font-size: 13px; text-align: left; border-bottom: 2px solid #015E65;">Voucher Code</th>
                  <th style="padding: 10px 16px; color: #015E65; font-size: 13px; text-align: left; border-bottom: 2px solid #015E65;">Valid From</th>
                  <th style="padding: 10px 16px; color: #015E65; font-size: 13px; text-align: left; border-bottom: 2px solid #015E65;">Valid Until</th>
                </tr>
              </thead>
              <tbody>
                ${voucherRows}
              </tbody>
            </table>
            ${termsSection}
            <p style="color: #333; font-size: 14px; margin-top: 24px;">If you have any questions, please don't hesitate to reach out.</p>
            <p style="color: #333; font-size: 14px;">Best regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
          </div>
          <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
            <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
            <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
          </div>
        </div>
      `,
    });

    return NextResponse.json({ message: "Voucher email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error);
    return NextResponse.json(
      { error: "Failed to send email. Check RESEND_API_KEY configuration." },
      { status: 500 }
    );
  }
}

// ===== Per-seat email HTML builder with WiFi instructions =====
function buildPerSeatEmailHTML(params: {
  recipientName: string;
  voucherCode: string;
  validFrom: string;
  validUntil: string;
  seatNumber: number;
  contractNumber: string;
  senderName: string;
}) {
  const { recipientName, voucherCode, validFrom, validUntil, seatNumber, contractNumber, senderName } = params;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Your WiFi Access Code</p>
      </div>
      <div style="padding: 32px;">
        <p style="color: #1a1b1e; font-size: 15px;">Hello ${recipientName},</p>
        <p style="color: #333; font-size: 14px;">Here is your personal internet access code for The WorkVilla (Seat #${seatNumber}, Contract ${contractNumber}).</p>

        <!-- Voucher Code Box -->
        <div style="text-align: center; margin: 24px 0; padding: 20px; background: #f0faf5; border-radius: 8px; border: 2px solid #015E65;">
          <p style="color: #015E65; font-size: 13px; margin: 0 0 8px;">Your Voucher Code</p>
          <p style="color: #015E65; font-size: 32px; font-weight: bold; margin: 0; letter-spacing: 4px; font-family: monospace;">${voucherCode}</p>
        </div>

        <!-- Validity -->
        <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Valid From</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb; text-align: right;">${validFrom}</td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px;">Valid Until</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; text-align: right;">${validUntil}</td>
          </tr>
        </table>

        <!-- WiFi Instructions -->
        <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
          <h3 style="color: #015E65; margin: 0 0 12px; font-size: 14px;">How to Connect</h3>
          <ol style="color: #555; font-size: 13px; margin: 0; padding-left: 20px; line-height: 1.8;">
            <li>Connect to the WiFi network: <strong style="color: #015E65;">The WorkVilla</strong></li>
            <li>A login page will appear in your browser</li>
            <li>Enter the voucher code shown above</li>
            <li>Click <strong>Connect</strong> — you&apos;re online!</li>
          </ol>
          <p style="color: #888; font-size: 12px; margin: 12px 0 0;">This code is tied to your device. If you change your device, please contact The WorkVilla front desk for a replacement code.</p>
        </div>

        <p style="color: #333; font-size: 14px; margin-top: 24px;">If you have any questions, please reach out to the front desk or email us.</p>
        <p style="color: #333; font-size: 14px;">Best regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
      </div>
      <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
        <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
      </div>
    </div>
  `;
}
