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
  const { recipients, pdfBase64 } = body as {
    recipients: string[];
    pdfBase64: string;
  };

  if (!recipients || recipients.length === 0) {
    return NextResponse.json(
      { error: "At least one recipient email is required" },
      { status: 400 }
    );
  }

  if (!pdfBase64) {
    return NextResponse.json(
      { error: "PDF data is required" },
      { status: 400 }
    );
  }

  // Fetch proposal with lead info
  const { data: proposal, error: fetchError } = await supabase
    .from("proposals")
    .select(
      "*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company)"
    )
    .eq("id", id)
    .single();

  if (fetchError || !proposal) {
    return NextResponse.json(
      { error: "Proposal not found" },
      { status: 404 }
    );
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  try {
    // Convert base64 to Buffer
    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    await resend.emails.send({
      from: "TWV CRM <onboarding@resend.dev>",
      to: recipients,
      subject: `Proposal ${proposal.proposal_number} - ${proposal.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e40af;">TWV Coworking</h2>
          <p>Dear ${proposal.lead?.first_name || "Client"},</p>
          <p>Please find attached our proposal <strong>${proposal.proposal_number}</strong> for <strong>${proposal.title}</strong>.</p>
          <table style="border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 4px 12px; color: #666;">Proposal:</td><td style="padding: 4px 12px; font-weight: bold;">${proposal.proposal_number}</td></tr>
            <tr><td style="padding: 4px 12px; color: #666;">Amount:</td><td style="padding: 4px 12px; font-weight: bold;">₹${Number(proposal.total_amount).toLocaleString("en-IN")}</td></tr>
            ${proposal.valid_until ? `<tr><td style="padding: 4px 12px; color: #666;">Valid Until:</td><td style="padding: 4px 12px;">${new Date(proposal.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
          </table>
          <p>We look forward to hearing from you.</p>
          <p>Best regards,<br/>${senderName}<br/>TWV Coworking</p>
        </div>
      `,
      attachments: [
        {
          filename: `${proposal.proposal_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    // Update proposal status to "sent" and set sent_at
    await supabase
      .from("proposals")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error);
    return NextResponse.json(
      { error: "Failed to send email. Check RESEND_API_KEY configuration." },
      { status: 500 }
    );
  }
}
