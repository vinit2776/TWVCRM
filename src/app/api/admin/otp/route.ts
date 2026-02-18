import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/resend";
import { OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS } from "@/lib/constants";

/**
 * POST /api/admin/otp — Generate OTP for voucher replacement
 * Body: { reference_id: string, purpose?: string }
 * Sends OTP email to all admin + manager users
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { reference_id, purpose } = body as {
    reference_id: string;
    purpose?: string;
  };

  if (!reference_id) {
    return NextResponse.json({ error: "reference_id is required" }, { status: 400 });
  }

  // Get requester's DB user
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Generate 6-digit OTP
  const otpCode = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Store in DB
  const { data: otp, error: insertError } = await supabase
    .from("admin_otp")
    .insert({
      otp_code: otpCode,
      purpose: purpose || "voucher_replacement",
      reference_id,
      requested_by: dbUser.id,
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Fetch all admin + manager users' emails for OTP delivery
  const { data: approvers } = await supabase
    .from("users")
    .select("email, full_name, role")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);

  const approverEmails = (approvers || []).map((a) => a.email).filter(Boolean);

  if (approverEmails.length === 0) {
    return NextResponse.json(
      { error: "No admin or manager users found to receive OTP" },
      { status: 500 }
    );
  }

  // Send OTP email to all approvers
  try {
    const sendResult = await resend.emails.send({
      from: EMAIL_FROM,
      to: approverEmails,
      subject: `Voucher Replacement OTP — ${otpCode}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Voucher Replacement Authorization</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">A voucher replacement has been requested.</p>
            <p style="color: #333; font-size: 14px;">
              <strong>${dbUser.full_name}</strong> is requesting authorization to replace a voucher.
            </p>
            <div style="text-align: center; margin: 24px 0; padding: 20px; background: #f0faf5; border-radius: 8px; border: 2px solid #015E65;">
              <p style="color: #015E65; font-size: 13px; margin: 0 0 8px;">Your OTP Code</p>
              <p style="color: #015E65; font-size: 36px; font-weight: bold; margin: 0; letter-spacing: 8px; font-family: monospace;">${otpCode}</p>
              <p style="color: #666; font-size: 12px; margin: 8px 0 0;">Expires in ${OTP_EXPIRY_MINUTES} minutes</p>
            </div>
            <p style="color: #555; font-size: 13px;">Share this code with the requesting staff member to authorize the voucher replacement. Do not share if you are unsure about the request.</p>
          </div>
          <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
            <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
          </div>
        </div>
      `,
    });

    if (sendResult.error) {
      console.error("OTP Resend API error:", sendResult.error);
      return NextResponse.json(
        { error: `OTP created but email failed: ${sendResult.error.message}. Recipients: ${approverEmails.join(", ")}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("OTP email send error:", error);
    return NextResponse.json(
      { error: "OTP created but email delivery failed. Check Resend configuration." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    otp_id: otp.id,
    expires_at: otp.expires_at,
    sent_to_count: approverEmails.length,
  });
}

/**
 * PUT /api/admin/otp — Verify OTP
 * Body: { otp_id: string, otp_code: string }
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { otp_id, otp_code } = body as { otp_id: string; otp_code: string };

  if (!otp_id || !otp_code) {
    return NextResponse.json({ error: "otp_id and otp_code are required" }, { status: 400 });
  }

  // Fetch the OTP record
  const { data: otpRecord, error: fetchError } = await supabase
    .from("admin_otp")
    .select("*")
    .eq("id", otp_id)
    .single();

  if (fetchError || !otpRecord) {
    return NextResponse.json({ valid: false, reason: "OTP not found" }, { status: 404 });
  }

  // Check if already used
  if (otpRecord.is_used) {
    return NextResponse.json({ valid: false, reason: "OTP has already been used" }, { status: 400 });
  }

  // Check expiry
  if (new Date(otpRecord.expires_at) < new Date()) {
    return NextResponse.json({ valid: false, reason: "OTP has expired" }, { status: 400 });
  }

  // Check max attempts
  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    // Invalidate it
    await supabase
      .from("admin_otp")
      .update({ is_used: true })
      .eq("id", otp_id);
    return NextResponse.json(
      { valid: false, reason: "Too many attempts. OTP has been invalidated." },
      { status: 400 }
    );
  }

  // Increment attempts
  await supabase
    .from("admin_otp")
    .update({ attempts: otpRecord.attempts + 1 })
    .eq("id", otp_id);

  // Verify code
  if (otpRecord.otp_code !== otp_code) {
    const remaining = OTP_MAX_ATTEMPTS - (otpRecord.attempts + 1);
    return NextResponse.json(
      { valid: false, reason: `Invalid OTP code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` },
      { status: 400 }
    );
  }

  // Mark as used
  await supabase
    .from("admin_otp")
    .update({ is_used: true, verified_at: new Date().toISOString() })
    .eq("id", otp_id);

  return NextResponse.json({
    valid: true,
    reference_id: otpRecord.reference_id,
  });
}
