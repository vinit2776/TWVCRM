import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

/**
 * GET /api/dashboard/support
 * Returns aggregate counts for the Support Tickets widget.
 * Access: admin only.
 */
export async function GET() {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

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
