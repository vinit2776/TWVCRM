/**
 * GET /api/cron/comp-request-expiry
 *
 * Runs hourly. Finds any `comp_request` approval_requests whose
 * `expires_at` has passed while still `pending`, marks them
 * `expired`, and creates in-app notifications for the requesters.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { pingCronHealth } from "@/lib/cron-ping";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch all pending comp_request rows that have expired
  const { data: expired, error } = await admin
    .from("approval_requests")
    .select("id, requested_by, entity_reference, metadata")
    .eq("approval_type", "comp_request")
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString());

  if (error) {
    console.error("[cron/comp-request-expiry] fetch error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!expired || expired.length === 0) {
    await pingCronHealth("comp-request-expiry");
    return NextResponse.json({ expired: 0 });
  }

  // Mark them all expired
  const expiredIds = expired.map(r => r.id);
  const { error: updateErr } = await admin
    .from("approval_requests")
    .update({ status: "expired" })
    .in("id", expiredIds);

  if (updateErr) {
    console.error("[cron/comp-request-expiry] update error:", updateErr.message);
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Notify each requester (in-app)
  // Group by requester so we don't spam them if they have multiple expired requests
  const byRequester = new Map<string, typeof expired>();
  for (const row of expired) {
    const list = byRequester.get(row.requested_by) || [];
    list.push(row);
    byRequester.set(row.requested_by, list);
  }

  for (const [requesterId, rows] of byRequester.entries()) {
    const refs = rows
      .map(r => {
        const meta = (r.metadata || {}) as Record<string, unknown>;
        return meta.booking_number ? String(meta.booking_number) : (r.entity_reference ?? r.id);
      })
      .join(", ");

    await createNotificationsForUsers([requesterId], {
      type:  "comp_request_expired",
      title: rows.length === 1
        ? `Comp request expired — ${refs}`
        : `${rows.length} comp requests expired`,
      body:  rows.length === 1
        ? `Your complimentary request for ${refs} was not reviewed in time and has expired. You may re-submit if still needed.`
        : `Your complimentary requests for ${refs} expired without being reviewed. Re-submit if still needed.`,
      url:   rows.length === 1
        ? `/bookings/${refs}`
        : `/approvals`,
    });
  }

  await pingCronHealth("comp-request-expiry");
  return NextResponse.json({ expired: expired.length, ids: expiredIds });
}
