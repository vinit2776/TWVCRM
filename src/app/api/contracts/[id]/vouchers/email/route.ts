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

  // Fetch voucher issuances with voucher details
  const { data: issuances, error: issuanceError } = await supabase
    .from("voucher_issuances")
    .select(
      "*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at)"
    )
    .eq("contract_id", id)
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

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  // Build voucher table rows
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
