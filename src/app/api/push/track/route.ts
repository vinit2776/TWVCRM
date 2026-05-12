import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/push/track
 * Beacon endpoint hit by the service worker when:
 *   • event=delivered  — push arrived on the device
 *   • event=clicked    — user tapped the notification
 *
 * No auth: the SW can't sign requests, and we match on (batch_id, endpoint)
 * which is hard to spoof at scale (endpoint includes a random subscription id).
 * Worst-case spoofing inflates a single batch's metrics — not security-sensitive.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const batchId  = (body.batchId  || "").toString();
  const endpoint = (body.endpoint || "").toString();
  const event    = (body.event    || "").toString();

  if (!batchId || !endpoint || !["delivered", "clicked"].includes(event)) {
    return NextResponse.json({ error: "Invalid beacon" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const patch: Record<string, string> =
    event === "delivered"
      ? { status: "delivered", delivered_at: now }
      : { status: "clicked",   clicked_at:   now };

  await supabase
    .from("push_delivery_log")
    .update(patch)
    .eq("batch_id", batchId)
    .eq("endpoint", endpoint);

  return NextResponse.json({ ok: true });
}
