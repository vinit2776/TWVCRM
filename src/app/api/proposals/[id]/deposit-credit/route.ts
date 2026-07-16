import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

/**
 * POST /api/proposals/[id]/deposit-credit
 *
 * Records a security deposit credit already held from a prior contract
 * (e.g. a terminated contract's refundable deposit) against this
 * proposal's required deposit. Does NOT change security_deposit_amount —
 * that stays the true required deposit for history — it only records
 * how much of it is already covered, so the deposit-link/email flow can
 * collect just the balance.
 *
 * Accepts multipart/form-data with:
 *   - amount        (required) numeric string, must be > 0 and <= the
 *                    proposal's security_deposit_amount
 *   - reason        (required) free text — why less deposit is being
 *                    collected, kept for audit
 *   - proof         (required) image or PDF — accounts' confirmation of
 *                    the held deposit — uploaded to crm-documents storage
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

  if (!actor || !["admin", "manager"].includes(actor.role)) {
    return NextResponse.json({ error: "Only an admin or manager can apply a deposit credit" }, { status: 403 });
  }

  const formData = await request.formData();
  const amountRaw = formData.get("amount") as string | null;
  const reason = (formData.get("reason") as string | null)?.trim() || "";
  const proofFile = formData.get("proof") as File | null;

  const amount = parseFloat(amountRaw || "");
  if (!amountRaw || isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valid credit amount is required" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "A reason is required — this is kept for audit" }, { status: 400 });
  }
  if (!proofFile || proofFile.size === 0) {
    return NextResponse.json({ error: "Proof of the held deposit is required" }, { status: 400 });
  }

  const { data: proposal } = await supabase.from("proposals").select("*").eq("id", id).single();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (proposal.deposit_payment_status === "paid") {
    return NextResponse.json({ error: "Deposit is already paid — cannot apply a credit" }, { status: 400 });
  }

  const requiredDeposit = Number(proposal.security_deposit_amount || 0);
  if (amount > requiredDeposit) {
    return NextResponse.json(
      { error: `Credit cannot exceed the required deposit of ₹${requiredDeposit.toLocaleString("en-IN")}` },
      { status: 400 }
    );
  }

  const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `proposals/${id}/deposit-credit-proof-${Date.now()}.${ext}`;
  const buffer = Buffer.from(await proofFile.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(path, buffer, {
      contentType: proofFile.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    console.error("[deposit-credit] storage upload error:", uploadError);
    return NextResponse.json({ error: "Failed to upload proof" }, { status: 500 });
  }

  let proofUrl: string | null = null;
  const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
  proofUrl = urlData?.publicUrl || null;
  if (!proofUrl) {
    const { data: signed } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(path, 60 * 60 * 24 * 365);
    proofUrl = signed?.signedUrl || null;
  }

  const appliedAt = new Date().toISOString();
  const update = {
    deposit_credit_amount: amount,
    deposit_credit_reason: reason,
    deposit_credit_proof_url: proofUrl,
    deposit_credit_applied_by: actor.id,
    deposit_credit_applied_at: appliedAt,
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
