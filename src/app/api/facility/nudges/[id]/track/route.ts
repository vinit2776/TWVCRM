import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// 1x1 transparent GIF, served on every hit regardless of what happens below —
// tracking pixels must never error or the email client shows a broken image.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
  "base64"
);

/**
 * GET /api/facility/nudges/[id]/track
 * Email open-tracking pixel for a facility ticket nudge. Mirrors the
 * existing pattern used for billing reminders / proposal emails — this is
 * "opened", not a true delivery receipt (no Resend webhook exists in this
 * codebase for that).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const supabase = createAdminClient();
    await supabase
      .from("facility_issue_nudges")
      .update({ status: "opened", opened_at: new Date().toISOString() })
      .eq("id", id)
      .eq("channel", "email")
      .is("opened_at", null);
  } catch (err) {
    console.error("[facility-nudge-track] failed:", err);
  }

  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
