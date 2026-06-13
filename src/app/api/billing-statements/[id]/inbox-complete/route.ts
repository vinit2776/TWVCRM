import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isHandoffV2Enabled, setHandoffState } from "@/lib/tally-handoff-server";
import type { HandoffState } from "@/lib/tally-handoff";

/**
 * POST /api/billing-statements/[id]/inbox-complete
 *
 * Manually marks an inbox row as complete. The bridge v2 sync (when
 * deployed) auto-completes statements that reach `paid_awaiting_receipt_record`
 * by matching the receipt voucher; this endpoint lets accounts close
 * the row from the UI when:
 *   - the bridge isn't deployed yet (today)
 *   - the bridge can't match the receipt (e.g. accounts entered it
 *     differently in Tally)
 *   - the GST was sent to a customer who paid later but Tally records
 *     aren't going to match automatically
 *
 * Only allowed on states that represent "work effectively done":
 *   - gst_sent_awaiting_payment (direct GST: customer might pay later, but
 *     accounts says manual reconciliation is done)
 *   - paid_awaiting_receipt_record (waiting on bridge — admin override)
 *   - gst_sent (PI flow, although it should now auto-close — defensive)
 *
 * Role gate: accounts/admin only.
 */
export const dynamic = "force-dynamic";

const ALLOWED_FROM_STATES: HandoffState[] = [
  "gst_sent",
  "gst_sent_awaiting_payment",
  "paid_awaiting_receipt_record",
];

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

  if (!(await isHandoffV2Enabled(supabase))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, handoff_state")
    .eq("id", id)
    .maybeSingle();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const currentState = statement.handoff_state as HandoffState | null;
  if (!currentState || !ALLOWED_FROM_STATES.includes(currentState)) {
    return NextResponse.json(
      {
        error: `Cannot close from state "${currentState}". Allowed: ${ALLOWED_FROM_STATES.join(", ")}.`,
      },
      { status: 409 },
    );
  }

  await setHandoffState(supabase, id, "complete", `inbox_manual_close_by_${dbUser.role}`);

  return NextResponse.json({ ok: true, handoff_state: "complete" });
}
