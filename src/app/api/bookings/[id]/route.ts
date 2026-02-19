import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

const BOOKING_SELECT = "*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate, location_id), location:locations!bookings_location_id_fkey(id, name, code, address, city, state), contract:contracts!bookings_contract_id_fkey(id, contract_number, lead_id), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile), facilities:booking_facilities(*)";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Also fetch voucher issuances for this booking
  const { data: vouchers } = await supabase
    .from("voucher_issuances")
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status)")
    .eq("booking_id", id)
    .eq("is_active", true);

  // Fetch feedback for this booking (if any)
  const { data: feedback } = await supabase
    .from("booking_feedbacks")
    .select("*, rater:users!booking_feedbacks_rated_by_fkey(id, full_name)")
    .eq("booking_id", id)
    .maybeSingle();

  return NextResponse.json({ data: { ...data, voucher_issuances: vouchers || [], feedback: feedback || null } });
}

export async function PATCH(
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

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const { data: booking } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  // Status transitions
  if (body.status) {
    const { status: newStatus } = body;
    const canManage = ["admin", "manager", "floor_manager"].includes(dbUser.role);

    switch (newStatus) {
      case "checked_in": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only check in confirmed bookings" }, { status: 400 });
        }
        if (!canManage) {
          return NextResponse.json({ error: "Only managers/floor managers can check in" }, { status: 403 });
        }
        updates.status = "checked_in";
        updates.check_in_at = new Date().toISOString();
        updates.checked_in_by = dbUser.id;
        break;
      }

      case "checked_out": {
        if (booking.status !== "checked_in") {
          return NextResponse.json({ error: "Can only check out checked-in bookings" }, { status: 400 });
        }
        if (!canManage) {
          return NextResponse.json({ error: "Only managers/floor managers can check out" }, { status: 403 });
        }
        updates.status = "checked_out";
        updates.check_out_at = new Date().toISOString();
        updates.checked_out_by = dbUser.id;
        break;
      }

      case "cancelled": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only cancel confirmed bookings" }, { status: 400 });
        }
        if (!canManage && booking.created_by !== dbUser.id) {
          return NextResponse.json({ error: "Insufficient permissions to cancel" }, { status: 403 });
        }
        updates.status = "cancelled";

        // Revoke voucher if walk-in or guest
        if (booking.customer_type === "walk_in" || booking.customer_type === "guest") {
          const { data: issuances } = await supabase
            .from("voucher_issuances")
            .select("id, voucher_id")
            .eq("booking_id", id)
            .eq("is_active", true);

          if (issuances) {
            for (const iss of issuances) {
              await supabase.from("voucher_issuances").update({ is_active: false, revoked_at: new Date().toISOString(), revoke_reason: "Booking cancelled" }).eq("id", iss.id);
              await supabase.from("voucher_repository").update({ status: "revoked" }).eq("id", iss.voucher_id);
            }
          }
        }

        // Waive usage charge if contract holder or guest
        if (booking.usage_charge_id) {
          await supabase.from("usage_charges").update({ status: "waived" }).eq("id", booking.usage_charge_id);
        }
        break;
      }

      case "no_show": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only mark no-show on confirmed bookings" }, { status: 400 });
        }
        if (!canManage) {
          return NextResponse.json({ error: "Only managers/floor managers can mark no-show" }, { status: 403 });
        }
        updates.status = "no_show";
        break;
      }

      default:
        return NextResponse.json({ error: `Invalid status transition: ${newStatus}` }, { status: 400 });
    }
  }

  // Payment updates
  if (body.payment_status) {
    updates.payment_status = body.payment_status;
  }
  if (body.payment_mode) {
    updates.payment_mode = body.payment_mode;
  }
  if (body.payment_reference) {
    updates.payment_reference = body.payment_reference;
  }

  // Refund updates (for no-show exceptions)
  if (body.refund_status) {
    updates.refund_status = body.refund_status;
  }
  if (body.refund_amount !== undefined) {
    updates.refund_amount = body.refund_amount;
  }
  if (body.refund_reason) {
    updates.refund_reason = body.refund_reason;
  }
  if (body.refund_status === "approved") {
    updates.refund_approved_by = dbUser.id;
    updates.refund_approved_at = new Date().toISOString();
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("bookings")
    .update(updates)
    .eq("id", id)
    .select(BOOKING_SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(booking, { ...booking, ...updates }),
  });

  // Log activity on lead timeline for status changes
  if (booking.lead_id && body.status) {
    const spaceName = (updated?.space as { name?: string } | null)?.name || "Conference Room";
    const activityMap: Record<string, { subject: string; description: string }> = {
      checked_in: {
        subject: `Checked In — ${booking.booking_number}`,
        description: `Checked in at ${spaceName} for booking #${booking.booking_number}`,
      },
      checked_out: {
        subject: `Checked Out — ${booking.booking_number}`,
        description: `Checked out from ${spaceName}. Booking #${booking.booking_number}`,
      },
      cancelled: {
        subject: `Booking Cancelled — ${booking.booking_number}`,
        description: `Booking #${booking.booking_number} at ${spaceName} was cancelled`,
      },
      no_show: {
        subject: `No-Show — ${booking.booking_number}`,
        description: `Customer did not show up for booking #${booking.booking_number} at ${spaceName}`,
      },
    };

    const activity = activityMap[body.status];
    if (activity) {
      await supabase.from("activities").insert({
        lead_id: booking.lead_id,
        type: "note",
        subject: activity.subject,
        description: activity.description,
        created_by: dbUser.id,
      });
    }
  }

  // Log refund approval activity
  if (booking.lead_id && body.refund_status === "approved") {
    await supabase.from("activities").insert({
      lead_id: booking.lead_id,
      type: "note",
      subject: `Refund Exception Approved — ${booking.booking_number}`,
      description: `Refund of ₹${body.refund_amount} approved for booking #${booking.booking_number}. Reason: ${body.refund_reason}`,
      created_by: dbUser.id,
    });
  }

  return NextResponse.json({ data: updated });
}
