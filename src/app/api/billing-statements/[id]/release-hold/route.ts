import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canRecordPayments } from "@/lib/constants";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/release-hold
 *
 * Clears a hold placed via POST .../hold, restoring the statement to the
 * normal send/GST-issuance flow. There is no other way off a hold — it
 * either gets released, or the underlying contract is terminated and the
 * statement becomes moot on its own.
 *
 * Guards: accounts/admin only (same as placing a hold); must currently be held.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !canRecordPayments(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can release a hold on a billing statement" },
      { status: 403 }
    );
  }

  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("id, held_at, hold_reason")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (!statement.held_at) {
    return NextResponse.json({ error: "Statement is not on hold" }, { status: 422 });
  }

  const previousReason = statement.hold_reason;

  const { data: updated, error: updateErr } = await supabase
    .from("billing_statements")
    .update({ held_at: null, held_by: null, hold_reason: null })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "statement_hold_released",
    performedBy: dbUser.id,
    changes: { hold_reason: { old: previousReason, new: null } },
  });

  return NextResponse.json(updated);
}
