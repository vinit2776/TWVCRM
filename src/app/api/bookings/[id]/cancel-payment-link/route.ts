/**
 * POST /api/bookings/[id]/cancel-payment-link
 *
 * Staff cancel a booking's open Razorpay payment link — for example when the
 * customer paid another way and the link is still live, which is how a
 * customer ends up paying twice. Cancels at Razorpay, clears the link from the
 * booking so the next "Collect Payment → Send link" makes a fresh one, and
 * writes an audit row.
 *
 * Unlike the best-effort cancel on reschedule, a Razorpay failure here is an
 * error: the point is that the link must no longer be payable. A link already
 * cancelled or expired at Razorpay counts as success; one already paid does
 * not, because the webhook must record that money instead.
 *
 * Authorisation: admin / manager / floor_manager.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getCachedSettings } from "@/lib/app-settings-cache";

const ALLOWED_ROLES = new Set(["admin", "manager", "floor_manager"]);

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Admin / manager / floor manager access required" },
      { status: 403 }
    );
  }

  const admin = createAdminClient();
  const { data: booking } = await admin
    .from("bookings")
    .select("id, razorpay_payment_link_id")
    .eq("id", id)
    .single();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const linkId = booking.razorpay_payment_link_id as string | null;
  if (!linkId) {
    return NextResponse.json({ error: "This booking has no open payment link" }, { status: 400 });
  }

  const settings = await getCachedSettings(admin, ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);
  const keyId = settings["razorpay_key_id"];
  const keySecret = settings["razorpay_key_secret"];
  if (settings["razorpay_enabled"] !== "true" || !keyId || !keySecret) {
    return NextResponse.json({ error: "Razorpay is not configured" }, { status: 400 });
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let outcome = "cancelled";
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const desc: string = err?.error?.description ?? "";
      if (/paid/i.test(desc) && !/not paid/i.test(desc)) {
        return NextResponse.json(
          { error: "This link has already been paid — wait for the payment to be recorded instead of cancelling." },
          { status: 409 }
        );
      }
      if (/cancelled|expired/i.test(desc)) {
        outcome = "already inactive at Razorpay";
      } else {
        return NextResponse.json(
          { error: `Razorpay could not cancel the link${desc ? `: ${desc}` : ""}` },
          { status: 502 }
        );
      }
    }
  } catch {
    return NextResponse.json({ error: "Could not reach Razorpay — the link is still live. Try again." }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  const { error } = await admin
    .from("bookings")
    .update({ razorpay_payment_link_id: null, razorpay_payment_link_url: null })
    .eq("id", id)
    // Don't wipe a fresh link someone made while we were talking to Razorpay.
    .eq("razorpay_payment_link_id", linkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  void logAudit(admin, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_link_cancelled: { old: linkId, new: outcome },
    },
  });

  return NextResponse.json({ success: true });
}
