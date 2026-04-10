import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST — create a waiver request and notify managers
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

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  const { data: waiverReq, error: waiverErr } = await supabase
    .from("waiver_requests")
    .insert({
      booking_id: id,
      requester_id: dbUser.id,
      waiver_type,
      waiver_amount: Number(waiver_amount),
      note: note || null,
      otp,
      otp_expires_at: expiresAt.toISOString(),
      status: "pending",
    })
    .select("id")
    .single();

  if (waiverErr) return NextResponse.json({ error: waiverErr.message }, { status: 500 });

  // Notify all managers/admins who have a phone number
  const { data: managers } = await supabase
    .from("users")
    .select("phone, first_name")
    .in("role", ["admin", "manager"])
    .not("phone", "is", null)
    .neq("phone", "");

  const requesterName = `${dbUser.first_name || ""} ${dbUser.last_name || ""}`.trim() || "Staff";
  const customerName = booking.lead
    ? `${(booking.lead as { first_name?: string; last_name?: string }).first_name || ""} ${(booking.lead as { first_name?: string; last_name?: string }).last_name || ""}`.trim()
    : "Walk-in";
  const spaceName = (booking.space as { name?: string })?.name || "Room";
  const amountStr = `₹${Number(waiver_amount).toLocaleString("en-IN")}`;

  if (managers && managers.length > 0) {
    for (const mgr of managers) {
      if (mgr.phone) {
        // Send WhatsApp with waiver details and OTP
        sendWhatsApp({
          to: mgr.phone,
          template: "waiver_approval_request",
          params: [
            requesterName,
            booking.booking_number,
            customerName,
            spaceName,
            amountStr,
            note || "No reason provided",
            otp,
          ],
          entityType: "booking",
          entityId: id,
        }).catch(() => {});
      }
    }
  }

  return NextResponse.json({
    data: { id: waiverReq?.id, otp_sent: true, expires_at: expiresAt.toISOString() },
  });
}

// PUT — confirm OTP and apply waiver
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

  // Find pending waiver request for this booking
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

  // Validate OTP
  if (waiverReq.otp !== otp.trim()) {
    return NextResponse.json({ error: "Invalid OTP. Please check with the manager." }, { status: 400 });
  }

  // Mark waiver as approved
  await supabase
    .from("waiver_requests")
    .update({ status: "approved", approved_by: dbUser.id, approved_at: new Date().toISOString() })
    .eq("id", waiverReq.id);

  return NextResponse.json({
    data: {
      approved: true,
      waiver_type: waiverReq.waiver_type,
      waiver_amount: waiverReq.waiver_amount,
    },
  });
}
