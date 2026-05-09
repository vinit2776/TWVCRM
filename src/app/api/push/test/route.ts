import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push";

/**
 * POST /api/push/test
 * Sends a test push notification to the authenticated user.
 * Admin-only endpoint for verifying push delivery.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const targetEmail = body.email || dbUser.id;

  let targetUserId = dbUser.id;
  if (body.email) {
    const { data: target } = await supabase
      .from("users").select("id").eq("email", body.email).single();
    if (target) targetUserId = target.id;
  }

  const count = await sendPushToUsers([targetUserId], {
    title: "TWV Push Test",
    body: body.message || "If you see this, push notifications are working!",
    url: "/facility/issues",
    tag: "push-test-" + Date.now(),
  });

  return NextResponse.json({ delivered: count, targetUserId });
}
