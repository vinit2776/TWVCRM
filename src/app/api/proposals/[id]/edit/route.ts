import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { editProposalSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

// Contract statuses that mean the proposal has become real occupancy history —
// once reached, the founding proposal's commercial terms are locked.
const CONTRACT_LOCK_STATUSES = ["active", "renewal_in_progress", "renewed", "expired", "terminated"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = editProposalSchema.safeParse(body);
  if (!result.success) {
    const fieldErrors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: result.error.issues }, { status: 400 });
  }

  const { data: oldProposal, error: fetchError } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchError || !oldProposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (oldProposal.deposit_payment_status === "paid") {
    return NextResponse.json(
      { error: "Cannot edit — the security deposit has already been collected on this proposal." },
      { status: 409 }
    );
  }
  if (oldProposal.payment_status === "paid") {
    return NextResponse.json(
      { error: "Cannot edit — the pro-rata / monthly invoice has already been paid on this proposal." },
      { status: 409 }
    );
  }

  const { data: linkedContracts } = await supabase
    .from("contracts")
    .select("id, contract_number, status")
    .eq("proposal_id", id);
  const lockingContract = (linkedContracts || []).find((c) =>
    CONTRACT_LOCK_STATUSES.includes(c.status as string)
  );
  if (lockingContract) {
    return NextResponse.json(
      {
        error: `Cannot edit — contract ${lockingContract.contract_number} linked to this proposal is already ${lockingContract.status}.`,
      },
      { status: 409 }
    );
  }

  const { service_quotas, ...proposalFields } = result.data;

  const items = proposalFields.items;
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * (proposalFields.tax_percentage / 100);
  const discountAmount = subtotal * (proposalFields.discount_percentage / 100);
  const totalAmount = subtotal + taxAmount - discountAmount;

  const depositMonths = proposalFields.security_deposit_months || 0;
  const isDepositRequired = depositMonths > 0;
  const depositAmount = proposalFields.security_deposit_amount ?? (depositMonths * subtotal);
  const wasDepositRequired = Number(oldProposal.security_deposit_months || 0) > 0;

  const updateFields: Record<string, unknown> = {
    ...proposalFields,
    subtotal,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    total_amount: totalAmount,
    security_deposit_months: depositMonths,
    security_deposit_amount: isDepositRequired ? depositAmount : 0,
    deposit_payment_status: isDepositRequired ? "pending" : "not_required",
    // Any existing link/PDF/invoice was generated against the pre-edit totals — invalidate it.
    razorpay_payment_link_id: null,
    razorpay_payment_link_url: null,
    deposit_razorpay_link_id: null,
    deposit_razorpay_link_url: null,
    pdf_storage_path: null,
    occupation_start_date: null,
  };

  // A deposit that just became required makes any prior zero-deposit OTP waiver moot.
  if (!wasDepositRequired && isDepositRequired) {
    updateFields.deposit_waiver_verified_at = null;
    updateFields.deposit_waiver_verified_by = null;
    updateFields.deposit_waiver_requested_at = null;
    updateFields.deposit_waiver_otp = null;
    updateFields.deposit_waiver_otp_expires = null;
  }

  // The customer may already have seen this proposal — force it back through send/accept.
  if (oldProposal.status !== "draft") {
    updateFields.status = "draft";
    updateFields.sent_at = null;
    updateFields.viewed_at = null;
    updateFields.accepted_at = null;
    updateFields.rejected_at = null;
    updateFields.rejection_reason = null;
  }

  const { data, error } = await supabase
    .from("proposals")
    .update(updateFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldProposal as Record<string, unknown>, updateFields),
    });
  }

  // Replace service quotas wholesale to match the edited form.
  await supabase.from("proposal_service_quotas").delete().eq("proposal_id", id);
  if (service_quotas && service_quotas.length > 0) {
    const quotaRows = service_quotas.map((q) => ({
      proposal_id: id,
      service_id: q.service_id,
      monthly_quota: q.monthly_quota,
      overage_rate: q.overage_rate,
    }));
    const { error: quotaError } = await supabase.from("proposal_service_quotas").insert(quotaRows);
    if (quotaError) {
      console.error("[proposals/edit] Failed to replace proposal_service_quotas:", quotaError.message);
    }
  }

  return NextResponse.json({ data });
}
