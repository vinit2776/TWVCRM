import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/notifications?limit=20&cursor=<iso-date>
 * Returns the current user's notifications, newest first.
 * Cursor-based pagination using created_at.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 20, 50);
  const cursor = searchParams.get("cursor"); // ISO date string

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("user_id", dbUser.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Unread count windowed to the last 30 days — nothing today marks old
  // notifications read on its own, so without a window the badge just
  // accumulates forever and stops meaning "needs your attention" (a ticket
  // update from months ago showing up as "you have 103 things to check" is
  // noise, not a signal). Old unread rows are still fully visible in the list,
  // just excluded from the badge/header count.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", dbUser.id)
    .is("read_at", null)
    .gte("created_at", thirtyDaysAgo);

  return NextResponse.json({
    data: data ?? [],
    unreadCount: count ?? 0,
    nextCursor: data && data.length === limit ? data[data.length - 1].created_at : null,
  });
}

/**
 * PATCH /api/notifications
 * Body: { action: "read_all" }
 * Marks all unread notifications as read.
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();

  if (body.action === "read_all") {
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", dbUser.id)
      .is("read_at", null);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (body.action === "read" && body.id) {
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("user_id", dbUser.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
