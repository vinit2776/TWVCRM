import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { revokeContractAccess } from "@/lib/contract-lifecycle";

/**
 * POST /api/contracts/[id]/cancel-renewal
 *
 * Cancels an in-progress renewal on a contract: deletes the still-draft
 * renewal contract, rejects any pending escalation approval tied to it,
 * and resolves the parent back out of "renewal_in_progress" — to "active"
 * if its own term still has time left (the nightly contract-expiry cron
 * takes it from there), or straight to "expired" with the same access
 * revocation that cron performs if the term has already lapsed.
 *
 * This exists because there is no other path to cancel a renewal once a
 * draft has been created: the Decline-renewal flow only accepts
 * active/expired contracts, and nothing in the UI calls the generic
 * draft-contract DELETE.
 *
 * Body: { reason: string }
 */
const ALLOWED_ROLES = ["admin", "manager", "sales_rep"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({
      error: "You do not have permission to cancel a renewal. Please ask your manager or admin.",
    }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = (body.reason || "").trim();
  if (!reason) {
    return NextResponse.json({ error: "A reason is required" }, { status: 400 });
  }

  const { data: parent, error: parentErr } = await supabase
    .from("contracts")
    .select("id, contract_number, status, end_date, unifi_voucher_id")
    .eq("id", id)
    .single();
  if (parentErr || !parent) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (parent.status !== "renewal_in_progress") {
    return NextResponse.json({
      error: `This contract is "${parent.status}", not renewal_in_progress — there is no renewal to cancel.`,
    }, { status: 400 });
  }

  // The active renewal draft is the highest-sequence child that hasn't been
  // rejected — mirrors fetchActiveRenewalDraftsByParentId in billing.ts.
  const { data: children } = await supabase
    .from("contracts")
    .select("id, contract_number, status, escalation_approval_id")
    .eq("parent_contract_id", id)
    .neq("status", "rejected")
    .order("renewal_sequence", { ascending: false })
    .limit(1);

  const draft = children?.[0];
  if (!draft) {
    return NextResponse.json({
      error: "No renewal draft found for this contract. It may already have been resolved — refresh and check its status.",
    }, { status: 404 });
  }
  if (draft.status !== "draft") {
    return NextResponse.json({
      error: `The renewal (${draft.contract_number}) is already "${draft.status}" — it has been sent to the customer. Reject it directly instead of cancelling here.`,
    }, { status: 409 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // 1. Reject any pending escalation approval tied to the draft, so it
  //    doesn't sit in the approvals queue pointing at a deleted contract.
  if (draft.escalation_approval_id) {
    const { data: approval } = await admin
      .from("approval_requests")
      .select("id, status")
      .eq("id", draft.escalation_approval_id)
      .maybeSingle();
    if (approval?.status === "pending") {
      await admin
        .from("approval_requests")
        .update({
          status: "rejected",
          rejection_reason: `Renewal cancelled: ${reason}`,
          acted_by: dbUser.id,
          acted_at: now,
        })
        .eq("id", approval.id);
    }
  }

  // 2. Delete the draft renewal contract — nobody outside TWV has seen it.
  const { error: deleteErr } = await admin.from("contracts").delete().eq("id", draft.id);
  if (deleteErr) {
    return NextResponse.json({ error: `Failed to delete renewal draft: ${deleteErr.message}` }, { status: 500 });
  }

  // 3. Resolve the parent. If its term already lapsed, expire it now (with
  //    the same access revocation the nightly cron would eventually perform)
  //    rather than leaving it "active" with a past end_date until 18:30 IST.
  const today = new Date().toISOString().slice(0, 10);
  const alreadyLapsed = !!parent.end_date && parent.end_date < today;
  const newStatus = alreadyLapsed ? "expired" : "active";

  const { error: updateErr } = await admin
    .from("contracts")
    .update({
      status: newStatus,
      renewal_declined: true,
      renewal_declined_reason: reason,
      renewal_declined_at: now,
      renewal_declined_by: dbUser.id,
    })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  if (alreadyLapsed) {
    await revokeContractAccess(admin, {
      id: parent.id,
      contract_number: parent.contract_number,
      unifi_voucher_id: parent.unifi_voucher_id,
    });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: draft.id,
    action: "delete",
    performedBy: dbUser.id,
    changes: { record: { old: draft, new: null }, cancel_reason: { old: null, new: reason } },
  });
  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "renewal_in_progress", new: newStatus },
      renewal_declined: { old: false, new: true },
      renewal_declined_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({
    message: alreadyLapsed
      ? `Renewal cancelled. ${parent.contract_number} has been marked expired and access revoked.`
      : `Renewal cancelled. ${parent.contract_number} is active and will run through its existing term (${parent.end_date}).`,
    contract_status: newStatus,
  });
}
