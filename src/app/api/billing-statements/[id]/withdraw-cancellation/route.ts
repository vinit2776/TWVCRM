import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canCancelInvoice } from "@/lib/invoice-cancel";

/**
 * POST /api/billing-statements/[id]/withdraw-cancellation
 *
 * Takes back a GST-invoice cancellation request before Accounts has uploaded
 * the credit note. Reminders resume. The payment link was cancelled when the
 * request was made and is not revived — reissue it from the row if needed.
 *
 * Roles: admin, manager (same as requesting). Refused once the statement is
 * voided, i.e. the credit note is already recorded.
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !canCancelInvoice(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or manager can withdraw a cancellation" }, { status: 403 });
  }

  const admin = createAdminClient();
  // Read the request first: clearing the columns would otherwise erase what
  // the audit row needs to say was withdrawn.
  const { data: pending } = await admin
    .from("billing_statements")
    .select("cancellation_requested_at, cancellation_requested_by, cancellation_reason")
    .eq("id", id)
    .maybeSingle();
  const { data: updated, error } = await admin
    .from("billing_statements")
    .update({ cancellation_requested_at: null, cancellation_requested_by: null, cancellation_reason: null })
    .eq("id", id)
    .not("cancellation_requested_at", "is", null)
    .is("voided_at", null)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "There is no open cancellation request on this invoice (it may already be cancelled)." },
      { status: 409 },
    );
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      cancellation_requested: { old: "requested", new: "withdrawn" },
      ...(pending?.cancellation_reason ? { cancellation_reason: { old: pending.cancellation_reason, new: null } } : {}),
      ...(pending?.cancellation_requested_by ? { cancellation_requested_by: { old: pending.cancellation_requested_by, new: null } } : {}),
      ...(pending?.cancellation_requested_at ? { cancellation_requested_at: { old: pending.cancellation_requested_at, new: null } } : {}),
    },
  });

  return NextResponse.json({ success: true });
}
