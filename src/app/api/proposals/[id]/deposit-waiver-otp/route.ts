import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import type { SupabaseClient } from "@supabase/supabase-js";

function logWaiverActivity(
  supabase: SupabaseClient,
  leadId: string | null,
  subject: string,
  description: string,
  createdBy: string
) {
  if (!leadId) return;
  supabase.from("activities").insert({
    lead_id: leadId,
    type: "note",
    subject,
    description,
    created_by: createdBy,
  }).then(({ error }: { error: { message: string } | null }) => {
    if (error) console.error("[deposit-waiver activity]", error.message);
  });
}
import { formatCurrency } from "@/lib/utils";

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * POST /api/proposals/[id]/deposit-waiver-otp
 *
 * Actions (via JSON body `{ action }`):
 *   "request"  — generate OTP, email all admins (sales rep or any auth'd user)
 *   "resend"   — regenerate OTP, re-email admins
 *   "verify"   — verify OTP entered by sales rep → unlocks proposal
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const action: string = body.action;

  if (!["request", "resend", "verify"].includes(action)) {
    return NextResponse.json({ error: "Invalid action. Use: request, resend, verify" }, { status: 400 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, full_name, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { data: proposal, error: fetchErr } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone), location:locations!proposals_location_id_fkey(name)")
    .eq("id", id)
    .single();

  if (fetchErr || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (Number(proposal.security_deposit_months || 0) > 0) {
    return NextResponse.json({ error: "Deposit waiver OTP is only for zero-deposit proposals" }, { status: 400 });
  }

  // ── REQUEST / RESEND: generate OTP and email admins ──────────────────────
  if (action === "request" || action === "resend") {
    if (proposal.deposit_waiver_verified_at) {
      return NextResponse.json({ error: "Waiver already verified" }, { status: 400 });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const adminClient = createAdminClient();
    await adminClient
      .from("proposals")
      .update({
        deposit_waiver_otp: otp,
        deposit_waiver_otp_expires: expiresAt,
        deposit_waiver_requested_at: new Date().toISOString(),
      })
      .eq("id", id);

    // Fetch all admin users
    const { data: admins } = await adminClient
      .from("users")
      .select("email, full_name")
      .eq("role", "admin");

    if (!admins || admins.length === 0) {
      return NextResponse.json({ error: "No admin users found to send OTP" }, { status: 500 });
    }

    const adminEmails = admins.map((a) => a.email).filter(Boolean) as string[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = proposal.lead as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const location = proposal.location as any;
    const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Unknown";
    const companyName = lead?.company || "—";

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#015E65;padding:24px 32px;">
          <h1 style="color:#fff;margin:0;font-size:20px;">Deposit Waiver Approval Required</h1>
          <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">The WorkVilla CRM</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#333;font-size:14px;">A proposal with <strong>zero security deposit</strong> requires your approval. If you approve, share the OTP below with the sales representative.</p>

          <div style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
            <p style="color:#92400E;font-size:12px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">APPROVAL OTP</p>
            <p style="color:#92400E;font-size:36px;font-weight:900;letter-spacing:8px;margin:0;">${otp}</p>
            <p style="color:#B45309;font-size:11px;margin:8px 0 0;">Valid for 24 hours</p>
          </div>

          <p style="color:#015E65;font-size:13px;font-weight:700;margin:20px 0 8px;letter-spacing:0.3px;">PROPOSAL DETAILS</p>
          <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Proposal</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Customer</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${customerName}${companyName !== "—" ? ` (${companyName})` : ""}</td></tr>
            ${lead?.email ? `<tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Email</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${lead.email}</td></tr>` : ""}
            ${lead?.phone ? `<tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Phone</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${lead.phone}</td></tr>` : ""}
            ${location?.name ? `<tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Location</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${location.name}</td></tr>` : ""}
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Monthly Value</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${formatCurrency(proposal.total_amount)}/month</td></tr>
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Security Deposit</td><td style="padding:10px 16px;font-weight:bold;color:#DC2626;border-bottom:1px solid #e5e7eb;">₹0 — WAIVED</td></tr>
            <tr><td style="padding:10px 16px;color:#666;">Requested By</td><td style="padding:10px 16px;color:#333;">${dbUser.full_name || "Team Member"}</td></tr>
          </table>

          <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;margin:24px 0;">
            <p style="color:#991B1B;font-size:13px;font-weight:600;margin:0 0 4px;">⚠ Important</p>
            <p style="color:#7F1D1D;font-size:12px;margin:0;">Share this OTP only if you approve waiving the security deposit for this customer. The proposal cannot be sent to the customer without this approval.</p>
          </div>
        </div>
        <div style="background:#015E65;padding:16px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
          <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">The WorkVilla CRM — Internal Use Only</p>
        </div>
      </div>
    `;

    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: adminEmails,
      replyTo: EMAIL_REPLY_TO,
      subject: `🔐 Deposit Waiver OTP — ${proposal.proposal_number} (${customerName})`,
      html,
    });

    if (emailError) {
      console.error("[deposit-waiver-otp] Email error:", emailError);
      return NextResponse.json({ error: "Failed to send OTP email to admins" }, { status: 502 });
    }

    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { deposit_waiver_otp: { old: null, new: `${action}ed` } },
    });

    const isResend = action === "resend";
    logWaiverActivity(
      supabase,
      proposal.lead_id,
      `🔐 ${isResend ? "Deposit Waiver OTP Resent" : "Deposit Waiver OTP Requested"} — ${proposal.proposal_number}`,
      `${dbUser.full_name || "A team member"} ${isResend ? "resent" : "requested"} an admin approval OTP for zero-deposit waiver on proposal ${proposal.proposal_number}. OTP emailed to ${adminEmails.length} admin(s). Valid for 24 hours.`,
      dbUser.id
    );

    return NextResponse.json({
      message: isResend
        ? "New OTP sent to admin(s). Please ask your admin to check their email."
        : "OTP request sent to admin(s). Please ask your admin to share the OTP with you.",
      sent_to_count: adminEmails.length,
    });
  }

  // ── VERIFY: check OTP entered by user ────────────────────────────────────
  if (action === "verify") {
    const { otp } = body;
    if (!otp || typeof otp !== "string" || otp.length !== 6) {
      return NextResponse.json({ error: "Please enter a valid 6-digit OTP" }, { status: 400 });
    }

    if (proposal.deposit_waiver_verified_at) {
      return NextResponse.json({ message: "Already verified", verified: true });
    }

    if (!proposal.deposit_waiver_otp) {
      return NextResponse.json({ error: "No OTP has been requested yet. Please request an OTP first." }, { status: 400 });
    }

    if (new Date(proposal.deposit_waiver_otp_expires) < new Date()) {
      return NextResponse.json({ error: "OTP has expired. Please request a new one." }, { status: 400 });
    }

    if (proposal.deposit_waiver_otp !== otp) {
      return NextResponse.json({ error: "Invalid OTP. Please check with your admin and try again." }, { status: 400 });
    }

    // OTP matches — mark as verified
    const adminClient = createAdminClient();
    await adminClient
      .from("proposals")
      .update({
        deposit_waiver_verified_at: new Date().toISOString(),
        deposit_waiver_verified_by: dbUser.id,
        deposit_waiver_otp: null, // clear OTP after use
      })
      .eq("id", id);

    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { deposit_waiver: { old: "pending", new: "verified" } },
    });

    logWaiverActivity(
      supabase,
      proposal.lead_id,
      `✅ Deposit Waiver Approved — ${proposal.proposal_number}`,
      `Zero-deposit waiver approved via admin OTP for proposal ${proposal.proposal_number} (${formatCurrency(proposal.total_amount)}/month). Proposal is now unlocked for sending and download. Approved by: ${dbUser.full_name || "team member"}.`,
      dbUser.id
    );

    return NextResponse.json({
      message: "Deposit waiver approved. You can now send and download this proposal.",
      verified: true,
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
