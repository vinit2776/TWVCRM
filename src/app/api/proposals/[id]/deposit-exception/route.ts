import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { hasLiveInstalments } from "@/lib/deposit-instalment-server";

/**
 * POST /api/proposals/[id]/deposit-exception
 *
 * One-off exception override of the required security deposit itself —
 * distinct from deposit-credit (which nets an already-held credit) and from
 * the unrelated deposit_adjustments table (which draws the deposit DOWN
 * against a billing statement at settlement time). This is a signed delta:
 * positive raises the required deposit, negative lowers it. Does NOT change
 * security_deposit_amount — that stays the true baseline for history — it
 * only records the exception, same convention as deposit_credit_amount.
 *
 * Accepts multipart/form-data with:
 *   - amount  (required) signed numeric string, non-zero. Negative requires
 *             admin/manager; positive also allows sales_rep.
 *   - reason  (required) free text — why the required deposit is being
 *             overridden, kept for audit
 *   - proof   (optional) image or PDF supporting the exception
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const amountRaw = formData.get("amount") as string | null;
  const reason = (formData.get("reason") as string | null)?.trim() || "";
  const proofFile = formData.get("proof") as File | null;

  const amount = parseFloat(amountRaw || "");
  if (!amountRaw || isNaN(amount) || amount === 0) {
    return NextResponse.json({ error: "A non-zero exception amount is required" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "A reason is required — this is kept for audit" }, { status: 400 });
  }

  const isDecrease = amount < 0;
  const allowedRoles = isDecrease ? ["admin", "manager"] : ["admin", "manager", "sales_rep"];
  if (!allowedRoles.includes(actor.role)) {
    return NextResponse.json(
      { error: isDecrease ? "Only an admin or manager can reduce the required deposit" : "Only an admin, manager, or sales rep can raise the required deposit" },
      { status: 403 }
    );
  }

  const { data: proposal } = await supabase.from("proposals").select("*").eq("id", id).single();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (proposal.deposit_payment_status === "paid") {
    return NextResponse.json({ error: "Deposit is already paid — cannot apply an exception" }, { status: 400 });
  }

  const requiredDeposit = Number(proposal.security_deposit_amount || 0);
  if (requiredDeposit + amount < 0) {
    return NextResponse.json(
      { error: `Exception cannot reduce the required deposit below ₹0 (required: ₹${requiredDeposit.toLocaleString("en-IN")})` },
      { status: 400 }
    );
  }

  let proofUrl: string | null = null;
  if (proofFile && proofFile.size > 0) {
    const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `proposals/${id}/deposit-exception-proof-${Date.now()}.${ext}`;
    const buffer = Buffer.from(await proofFile.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(path, buffer, {
        contentType: proofFile.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error("[deposit-exception] storage upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload proof" }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
    proofUrl = urlData?.publicUrl || null;
    if (!proofUrl) {
      const { data: signed } = await supabase.storage
        .from("crm-documents")
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      proofUrl = signed?.signedUrl || null;
    }
  }

  const appliedAt = new Date().toISOString();
  const update = {
    deposit_exception_amount: amount,
    deposit_exception_reason: reason,
    deposit_exception_proof_url: proofUrl,
    deposit_exception_applied_by: actor.id,
    deposit_exception_applied_at: appliedAt,
  };

  const { data, error } = await supabase
    .from("proposals")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: diffChanges(proposal as Record<string, unknown>, update),
  });

  return NextResponse.json({ data });
}

/**
 * DELETE /api/proposals/[id]/deposit-exception
 *
 * Removes an exception that was entered, putting the required deposit back to
 * the proposal's own amount. Admin or manager only, with a reason (audit).
 *
 * Refused while anything has already been built on the adjusted amount:
 *   - the deposit is paid
 *   - parts have been asked for or paid (their totals assume the adjusted figure)
 *   - a deposit payment link is still live — it was issued for the adjusted
 *     amount and would let the customer settle the wrong figure. Cancel the
 *     link first (then send a fresh one at the restored amount).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !["admin", "manager"].includes(actor.role)) {
    return NextResponse.json({ error: "Only an admin or manager can remove a deposit exception" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10) {
    return NextResponse.json({ error: "Give a reason for removing the exception (at least 10 characters)" }, { status: 400 });
  }

  const { data: proposal } = await supabase.from("proposals").select("*").eq("id", id).single();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (Number(proposal.deposit_exception_amount || 0) === 0) {
    return NextResponse.json({ error: "There is no deposit exception on this proposal" }, { status: 400 });
  }
  if (proposal.deposit_payment_status === "paid") {
    return NextResponse.json({ error: "The deposit is already paid — the exception can no longer be removed" }, { status: 400 });
  }
  if (await hasLiveInstalments(createAdminClient(), id)) {
    return NextResponse.json({ error: "The deposit is being collected in parts. Cancel the open part request first (paid parts cannot be undone here)." }, { status: 409 });
  }
  if (proposal.deposit_razorpay_link_url && !proposal.deposit_link_cancelled_at) {
    return NextResponse.json({ error: "A deposit payment link is still live for the adjusted amount. Cancel the deposit link first, then remove the exception and send a fresh one." }, { status: 409 });
  }

  const update = {
    deposit_exception_amount: 0,
    deposit_exception_reason: null,
    deposit_exception_proof_url: null,
    deposit_exception_applied_by: null,
    deposit_exception_applied_at: null,
  };
  const { data, error } = await supabase.from("proposals").update(update).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: { ...diffChanges(proposal as Record<string, unknown>, update), deposit_exception_removed_reason: { old: null, new: reason } },
  });

  return NextResponse.json({ data });
}
