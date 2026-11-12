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
  const { waiver_type = "overtime", waiver_amount, note, usage_charge_id } = body;

  if (!waiver_amount || Number(waiver_amount) <= 0) {
    return NextResponse.json({ error: "waiver_amount required" }, { status: 400 });
  }

  // Contract-holder overtime charges are now real usage_charges rows.
  // usage_charge_id is optional (the walk-in/guest overtime flow has no
  // real charge behind it yet — out of scope here, left exactly as-is) —
  // but when provided, it must actually resolve so approval later knows
  // exactly which row to waive instead of guessing.
  let targetCharge: { id: string; status: string; booking_id: string } | null = null;
  if (usage_charge_id) {
    const { data } = await supabase
      .from("usage_charges")
      .select("id, status, booking_id")
      .eq("id", usage_charge_id)
      .eq("booking_id", id)
      .maybeSingle();
    if (!data) {
      return NextResponse.json({ error: "Usage charge not found for this booking" }, { status: 404 });
    }
    if (data.status !== "pending") {
      return NextResponse.json({ error: "Only pending charges can be waived" }, { status: 400 });
    }
    targetCharge = data;
  }

  // Fetch booking with lead info for the notification
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, space:spaces(name), lead:leads(first_name, last_name)")
    .eq("id", id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Expire any previous pending waiver for this booking. When a specific
  // charge is targeted, scope to that charge — a booking can accumulate
  // more than one charge over time and shouldn't expire an unrelated
  // still-pending request.
  let expireQuery = supabase
    .from("waiver_requests")
    .update({ status: "expired" })
    .eq("booking_id", id)
    .eq("status", "pending");
  expireQuery = targetCharge
    ? expireQuery.eq("usage_charge_id", targetCharge.id)
    : expireQuery.is("usage_charge_id", null);
  await expireQuery;

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  const { data: waiverReq, error: waiverErr } = await supabase
    .from("waiver_requests")
    .insert({
      booking_id: id,
      usage_charge_id: targetCharge?.id ?? null,
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

  // Execution is admin/manager only — possessing a valid OTP (e.g.
  // forwarded or screenshotted) used to be sufficient on its own. OTPs are
  // only ever emailed to admin/manager, but that's not a substitute for
  // checking the caller's own role here.
  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin and managers can approve waivers" },
      { status: 403 }
    );
  }

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

  // Actually waive the linked usage_charges row — same field-set as the
  // admin/manager waive branch in PATCH /api/usage-charges/[id].
  // waived_by is the APPROVING manager (otpRecord.manager_id), not the
  // floor_manager who submitted the request, since the manager is the one
  // authorizing the write-off. Guarded on status='pending' to avoid a
  // double-waive race with a concurrent direct waive.
  if (waiverReq.usage_charge_id) {
    // Snapshot the pre-waive amounts (the zeroing below is lossy) so the
    // booking's transaction breakdown can still show the original figure
    // alongside who approved the write-off.
    const { data: chargeBefore } = await supabase
      .from("usage_charges")
      .select("unit_price, total, gst_amount, total_with_gst")
      .eq("id", waiverReq.usage_charge_id)
      .maybeSingle();

    const { error: waiveErr } = await supabase
      .from("usage_charges")
      .update({
        status: "waived",
        waived_by: otpRecord.manager_id,
        waived_at: new Date().toISOString(),
        waive_reason: waiverReq.note || "Approved via OTP waiver flow",
        original_unit_price:     Number(chargeBefore?.unit_price ?? 0),
        original_total:          Number(chargeBefore?.total ?? 0),
        original_gst_amount:     Number(chargeBefore?.gst_amount ?? 0),
        original_total_with_gst: Number(chargeBefore?.total_with_gst ?? 0),
        unit_price: 0,
        total: 0,
        gst_amount: 0,
        total_with_gst: 0,
      })
      .eq("id", waiverReq.usage_charge_id)
      .eq("status", "pending");
    if (waiveErr) {
      console.error("[waiver-approve] failed to waive usage_charge:", waiveErr);
    }
  }

  return NextResponse.json({
    data: {
      approved: true,
      waiver_type: waiverReq.waiver_type,
      waiver_amount: waiverReq.waiver_amount,
      approved_by: otpRecord.manager_id,
    },
  });
}
