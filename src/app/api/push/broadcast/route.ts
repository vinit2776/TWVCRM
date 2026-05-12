import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { broadcastPush } from "@/lib/push";

/**
 * POST /api/push/broadcast
 * Send a Web Push notification to every subscribed device.
 * Admin-only. Returns batchId + sent/failed counts.
 *
 * Body: { title: string, body: string, url?: string, tag?: string, dryRun?: boolean }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const title = (body.title || "").toString().trim();
  const text = (body.body  || "").toString().trim();
  const url  = (body.url   || "/").toString().trim() || "/";
  const tag  = (body.tag   || `broadcast-${Date.now()}`).toString();

  if (!title || !text) {
    return NextResponse.json(
      { error: "title and body are required" },
      { status: 400 }
    );
  }

  if (body.dryRun) {
    // Count subscriptions without sending anything — useful for showing the
    // admin "how many devices will receive this?" before they confirm.
    const { count } = await supabase
      .from("push_subscriptions")
      .select("*", { count: "exact", head: true });
    return NextResponse.json({ dryRun: true, eligible: count ?? 0 });
  }

  const result = await broadcastPush({ title, body: text, url, tag });
  return NextResponse.json(result);
}
