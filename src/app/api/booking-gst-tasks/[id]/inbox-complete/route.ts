import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";

/**
 * POST /api/booking-gst-tasks/[id]/inbox-complete
 *
 * Manually marks a booking GST task as complete. Useful when:
 *   - Email was sent outside the system
 *   - The task was handled by other means
 *
 * Only allowed from ready_to_send state.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  const { data: task } = await adminClient
    .from("booking_gst_tasks")
    .select("id, handoff_state")
    .eq("id", id)
    .maybeSingle();

  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (!["ready_to_send", "gst_to_issue"].includes(task.handoff_state as string)) {
    return NextResponse.json(
      { error: `Cannot close from state "${task.handoff_state}".` },
      { status: 409 },
    );
  }

  await adminClient
    .from("booking_gst_tasks")
    .update({ handoff_state: "complete", updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, handoff_state: "complete" });
}
