import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [{ data, error }, { data: pushSubs }] = await Promise.all([
    supabase.from("users").select("*").order("full_name"),
    supabase.from("push_subscriptions").select("user_id"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Build set of user IDs that have at least one push subscription
  const pushEnabledIds = new Set((pushSubs ?? []).map((s) => s.user_id));

  const enriched = (data ?? []).map((u) => ({
    ...u,
    push_enabled: pushEnabledIds.has(u.id),
  }));

  return NextResponse.json({ data: enriched });
}
