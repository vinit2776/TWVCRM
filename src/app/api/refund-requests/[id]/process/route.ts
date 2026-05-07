/**
 * PATCH /api/refund-requests/[id]/process
 *
 * Finance records that the actual refund has been issued — money
 * left the bank, customer is whole. Captures the refund_method
 * (bank_transfer / cash / gateway / other) and a reference for the
 * audit trail (NEFT ID / cash voucher # / gateway refund ID).
 *
 * Only valid from `approved` status — finance shouldn't process a
 * pending or rejected request.
 *
 * Authorisation: admin / manager / accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const FINANCE_ROLES = new Set(["admin", "manager", "accounts"]);
const VALID_METHODS = new Set(["bank_transfer", "cash", "gateway", "other"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !FINANCE_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Admin / manager / accounts access required to process refunds" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const method = body.refund_method as string | undefined;
  const reference = (body.refund_reference as string | undefined)?.trim();
  const notes = (body.notes as string | undefined)?.trim() || null;

  if (!method || !VALID_METHODS.has(method)) {
    return NextResponse.json(
      { error: "refund_method must be bank_transfer / cash / gateway / other" },
      { status: 400 }
    );
  }
  if (!reference) {
    return NextResponse.json(
      { error: "refund_reference is required (NEFT ID / cash voucher # / gateway refund ID)" },
      { status: 400 }
    );
  }

  const { data: rr } = await supabase
    .from("refund_requests").select("*").eq("id", id).single();
  if (!rr) return NextResponse.json({ error: "Refund request not found" }, { status: 404 });

  if (rr.status !== "approved") {
    return NextResponse.json(
      { error: `Cannot process a ${rr.status} request — must be approved first` },
      { status: 400 }
    );
  }

  const { data: updated, error } = await supabase
    .from("refund_requests")
    .update({
      status: "processed",
      refund_method: method,
      refund_reference: reference,
      notes,
      processed_by: dbUser.id,
      processed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "refund_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "approved", new: "processed" },
      refund_method: { old: null, new: method },
      refund_reference: { old: null, new: reference },
    },
  });

  return NextResponse.json({ data: updated });
}
