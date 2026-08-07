import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

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
