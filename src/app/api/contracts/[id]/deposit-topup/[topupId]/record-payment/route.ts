import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const ALLOWED_ROLES = ["admin", "manager", "accounts", "office_admin"];

/**
 * POST /api/contracts/[id]/deposit-topup/[topupId]/record-payment
 *
 * Settles a PENDING top-up that was paid offline — the payment link went
 * out but the customer paid by NEFT/UPI/cheque instead. Without this the
 * top-up stays pending forever and keeps getting chased by the follow-up
 * ladder.
 *
 * Distinct from /deposit-topup/manual, which creates a brand-new already-
 * paid top-up for money received with no link ever sent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; topupId: string }> }
) {
  const { id: contractId, topupId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ALLOWED_ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "Not authorised to record a deposit payment" }, { status: 403 });
  }

  const formData = await request.formData();
  const paymentMode = (formData.get("payment_mode") as string | null)?.trim() || null;
  const reference = (formData.get("payment_reference") as string | null)?.trim() || null;
  const proofFile = formData.get("proof") as File | null;

  if (!paymentMode) {
    return NextResponse.json({ error: "Payment mode is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: topup } = await admin
    .from("deposit_topups")
    .select("id, status, amount")
    .eq("id", topupId)
    .eq("contract_id", contractId)
    .single();

  if (!topup) return NextResponse.json({ error: "Top-up not found" }, { status: 404 });
  if (topup.status !== "pending") {
    return NextResponse.json({ error: `Top-up is already ${topup.status}` }, { status: 422 });
  }

  let proofPath: string | null = null;
  if (proofFile && proofFile.size > 0) {
    const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `contracts/${contractId}/deposit-topup-proof-${Date.now()}.${ext}`;
    const buffer = Buffer.from(await proofFile.arrayBuffer());
    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(path, buffer, { contentType: proofFile.type || "application/octet-stream", upsert: false });
    if (uploadError) {
      console.error("[topup/record-payment] storage upload error:", uploadError);
    } else {
      const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
      proofPath = urlData?.publicUrl || null;
    }
  }

  const { data: rpcResult, error: rpcError } = await admin.rpc("mark_deposit_topup_paid_manual", {
    p_topup_id: topupId,
    p_payment_mode: paymentMode,
    p_payment_reference: reference,
    p_proof_path: proofPath,
    p_paid_by: actor.id,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not record payment" }, { status: 422 });
  }

  await logAudit(admin, {
    entityType: "deposit_topup",
    entityId: topupId,
    action: "deposit_topup_paid",
    performedBy: actor.id,
    changes: {
      status: { old: "pending", new: "paid" },
      payment_mode: { old: null, new: paymentMode },
      payment_reference: { old: null, new: reference },
    },
  });

  return NextResponse.json({ data: { id: topupId, status: "paid" } });
}
