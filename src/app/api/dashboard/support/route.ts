import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/support
 * Returns aggregate counts for the Support Tickets widget.
 * Access: admin only.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [{ count: openCount }, { count: buildApprovedCount }, { count: inProgressCount }] =
    await Promise.all([
      adminSupabase
        .from("support_tickets")
        .select("*", { count: "exact", head: true })
        .eq("status", "open"),
      adminSupabase
        .from("support_tickets")
        .select("*", { count: "exact", head: true })
        .eq("status", "build_approved"),
      adminSupabase
        .from("support_tickets")
        .select("*", { count: "exact", head: true })
        .eq("status", "in_progress"),
    ]);

  return NextResponse.json({
    data: {
      open: openCount ?? 0,
      in_progress: inProgressCount ?? 0,
      build_approved: buildApprovedCount ?? 0,
    },
  });
}
