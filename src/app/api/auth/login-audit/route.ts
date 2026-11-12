import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get the user's DB record
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Extract IP address from request headers
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : request.headers.get("x-real-ip") || "unknown";

  // Extract user agent
  const userAgent = request.headers.get("user-agent") || "unknown";

  // Update last_login_at on the users table
  await supabase
    .from("users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", dbUser.id);

  // Log the login audit event
  await logAudit(supabase, {
    entityType: "user",
    entityId: dbUser.id,
    action: "login",
    performedBy: dbUser.id,
    changes: {
      ip_address: { old: null, new: ip },
      user_agent: { old: null, new: userAgent },
      login_at: { old: null, new: new Date().toISOString() },
    },
  });

  // First-class session-start record for the activity storyboard (see user_sessions table).
  await supabase.from("user_sessions").insert({
    user_id: dbUser.id,
    ip_address: ip === "unknown" ? null : ip,
    user_agent: userAgent,
  });

  return NextResponse.json({ message: "Login audit logged" });
}
