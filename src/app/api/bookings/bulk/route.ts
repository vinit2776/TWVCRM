import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// POST — Bulk operations on bookings
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const { action, booking_ids } = body as { action: string; booking_ids: string[] };

  if (!action || !booking_ids || booking_ids.length === 0) {
    return NextResponse.json({ error: "action and booking_ids are required" }, { status: 400 });
  }

  const results: { id: string; success: boolean; error?: string }[] = [];

  for (const bookingId of booking_ids) {
    try {
      const { data: booking } = await supabase
        .from("bookings")
        .select("id, status, booking_number")
        .eq("id", bookingId)
        .single();

      if (!booking) {
        results.push({ id: bookingId, success: false, error: "Not found" });
        continue;
      }

      switch (action) {
        case "checkout": {
          if (booking.status !== "checked_in") {
            results.push({ id: bookingId, success: false, error: "Not checked in" });
            continue;
          }
          await supabase.from("bookings").update({
            status: "checked_out",
            check_out_at: new Date().toISOString(),
            checked_out_by: dbUser.id,
          }).eq("id", bookingId);
          results.push({ id: bookingId, success: true });
          break;
        }
        case "cancel": {
          if (booking.status !== "confirmed") {
            results.push({ id: bookingId, success: false, error: "Not confirmed" });
            continue;
          }
          await supabase.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
          results.push({ id: bookingId, success: true });
          break;
        }
        default:
          results.push({ id: bookingId, success: false, error: `Unknown action: ${action}` });
      }

      logAudit(supabase, {
        entityType: "booking",
        entityId: bookingId,
        action: "update",
        performedBy: dbUser.id,
        changes: { bulk_action: { old: booking.status, new: action } },
      });
    } catch {
      results.push({ id: bookingId, success: false, error: "Internal error" });
    }
  }

  const successCount = results.filter(r => r.success).length;
  return NextResponse.json({
    message: `${successCount}/${booking_ids.length} bookings processed`,
    results,
  });
}
