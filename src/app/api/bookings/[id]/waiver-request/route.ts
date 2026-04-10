import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { transporter, EMAIL_FROM } from "@/lib/mailer";

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST — create a waiver request and notify managers with unique OTPs
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, first_name, last_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["floor_manager", "manager", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const { waiver_type = "overtime", waiver_amount, note } = body;

  if (!waiver_amount || Number(waiver_amount) <= 0) {
    return NextResponse.json({ error: "waiver_amount required" }, { status: 400 });
  }

  // Fetch booking with lead info for the notification
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, space:spaces(name), lead:leads(first_name, last_name)")
    .eq("id", id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Expire any previous pending waiver for this booking
  await supabase
    .from("waiver_requests")
    .update({ status: "expired" })
    .eq("booking_id", id)
    .eq("status", "pending");

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  const { data: waiverReq, error: waiverErr } = await supabase
    .from("waiver_requests")
    .insert({
      booking_id: id,
      requester_id: dbUser.id,
      waiver_type,
      waiver_amount: Number(waiver_amount),
      note: note || null,
      otp_expires_at: expiresAt.toISOString(),
      status: "pending",
    })
    .select("id")
    .single();

  if (waiverErr) return NextResponse.json({ error: waiverErr.message }, { status: 500 });

  // Fetch all managers/admins with email
  const { data: managers } = await supabase
    .from("users")
    .select("id, email, first_name")
    .in("role", ["admin", "manager"])
    .not("email", "is", null)
    .neq("email", "");

  const requesterName = `${dbUser.first_name || ""} ${dbUser.last_name || ""}`.trim() || "Staff";
  const customerName = booking.lead
    ? `${(booking.lead as { first_name?: string; last_name?: string }).first_name || ""} ${(booking.lead as { first_name?: string; last_name?: string }).last_name || ""}`.trim()
    : "Walk-in";
  const spaceName = (booking.space as { name?: string })?.name || "Room";
  const amountStr = `₹${Number(waiver_amount).toLocaleString("en-IN")}`;
  const waiverTypeLabel = waiver_type === "overtime" ? "Overtime" : waiver_type === "extension" ? "Extension" : "Charge";

  if (managers && managers.length > 0) {
    for (const mgr of managers) {
      if (!mgr.email) continue;

      // Generate a unique OTP for each manager
      const otp = generateOtp();

      // Store the per-manager OTP
      await supabase.from("waiver_request_otps").insert({
        waiver_request_id: waiverReq!.id,
        manager_id: mgr.id,
        otp,
      });

      const emailHtml = `
        <div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#b45309">⚠️ Waiver Approval Request</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280">Requested by</td><td style="padding:6px 0;font-weight:600">${requesterName}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Booking</td><td style="padding:6px 0;font-weight:600">${booking.booking_number}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Customer</td><td style="padding:6px 0">${customerName}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Room</td><td style="padding:6px 0">${spaceName}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Waiver Type</td><td style="padding:6px 0">${waiverTypeLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Amount</td><td style="padding:6px 0;font-weight:600;color:#b45309">${amountStr}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Note</td><td style="padding:6px 0">${note || "No reason provided"}</td></tr>
          </table>
          <div style="margin-top:20px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:16px;text-align:center">
            <p style="margin:0 0 8px;font-size:13px;color:#92400e">Share this OTP with the floor manager to approve the waiver. This OTP is unique to you.</p>
            <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:8px;color:#78350f">${otp}</p>
            <p style="margin:8px 0 0;font-size:12px;color:#92400e">Valid for 15 minutes</p>
          </div>
          <p style="font-size:12px;color:#9ca3af;margin-top:16px">If you did not expect this request, please ignore this email.</p>
        </div>
      `;

      transporter.sendMail({
        from: EMAIL_FROM,
        to: mgr.email,
        subject: `Waiver Approval OTP — ${booking.booking_number} (${amountStr})`,
        html: emailHtml,
      }).catch(() => {});
    }
  }

  return NextResponse.json({
    data: { id: waiverReq?.id, otp_sent: true, expires_at: expiresAt.toISOString() },
  });
}

// PUT — verify OTP and apply waiver, recording which manager approved
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { otp } = body;
  if (!otp) return NextResponse.json({ error: "OTP required" }, { status: 400 });

  // Find the pending waiver request for this booking
  const { data: waiverReq } = await supabase
    .from("waiver_requests")
    .select("*")
    .eq("booking_id", id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!waiverReq) {
    return NextResponse.json({ error: "No pending waiver request found" }, { status: 404 });
  }

  // Check expiry
  if (new Date() > new Date(waiverReq.otp_expires_at)) {
    await supabase.from("waiver_requests").update({ status: "expired" }).eq("id", waiverReq.id);
    return NextResponse.json({ error: "OTP has expired. Please request a new waiver." }, { status: 400 });
  }

  // Find the matching per-manager OTP
  const { data: otpRecord } = await supabase
    .from("waiver_request_otps")
    .select("id, manager_id, used")
    .eq("waiver_request_id", waiverReq.id)
    .eq("otp", otp.trim())
    .maybeSingle();

  if (!otpRecord) {
    return NextResponse.json({ error: "Invalid OTP. Please check with the manager." }, { status: 400 });
  }

  if (otpRecord.used) {
    return NextResponse.json({ error: "This OTP has already been used." }, { status: 400 });
  }

  // Mark the specific OTP as used
  await supabase.from("waiver_request_otps").update({ used: true }).eq("id", otpRecord.id);

  // Approve the waiver, recording which manager's OTP was used
  await supabase
    .from("waiver_requests")
    .update({
      status: "approved",
      approved_by: otpRecord.manager_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", waiverReq.id);

  return NextResponse.json({
    data: {
      approved: true,
      waiver_type: waiverReq.waiver_type,
      waiver_amount: waiverReq.waiver_amount,
      approved_by: otpRecord.manager_id,
    },
  });
}
