import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { canRecordPayments } from "@/lib/constants";

/**
 * POST /api/proposals/[id]/payment
 * Records a manually-verified payment of the proposal's monthly / pro-rata
 * first invoice (bank transfer, cheque, cash).
 *
 * The sibling of /api/proposals/[id]/deposit-payment, which has covered the
 * security deposit for a long time. Until this existed, proposals.payment_status
 * could only be flipped by the Razorpay webhook, so a first invoice settled by
 * NEFT left the proposal 'pending' and the contract activation gate with no exit
 * but the admin override.
 *
 * Deliberately does NOT email the customer, unlike the deposit route. By the
 * time this is used the customer has normally already been receipted — a GST
 * invoice raised against an ad-hoc invoice, or their own bank confirmation — so
 * a second "payment received" mail reads like a duplicate charge. The deposit
 * mail exists because a deposit has no other receipt path.
 *
 * Accepts multipart/form-data:
 *   - amount         (required) numeric string
 *   - reference      (optional) UTR / transaction ID
 *   - payment_medium (optional) neft | rtgs | upi | cheque | cash | razorpay
 *   - notes          (required, ≥10 chars) internal note for accounts
 *   - payment_proof  (optional) image or PDF
 *   - shortfall_approved (optional) "true" — admin/manager only, ≤10% short
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
    .select("id, full_name, role")
    .eq("auth_id", user.id)
    .single();

  // Same roles as the deposit route — recording a payment is an accounts action.
  if (!actor || !canRecordPayments(actor.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can record a payment. Use \"Report paid\" to tell accounts about one." },
      { status: 403 },
    );
  }

  const formData = await request.formData();
  const amountRaw = formData.get("amount") as string | null;
  const reference = (formData.get("reference") as string | null)?.trim() || null;
  const paymentMedium = (formData.get("payment_medium") as string | null)?.trim() || null;
  const notes = (formData.get("notes") as string | null)?.trim() || null;
  const proofFile = formData.get("payment_proof") as File | null;
  const shortfallApproved = formData.get("shortfall_approved") === "true";

  const amount = parseFloat(amountRaw || "");
  if (!amountRaw || isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valid payment amount is required" }, { status: 400 });
  }
  if (!notes || notes.length < 10) {
    return NextResponse.json(
      { error: "Add an internal note (at least 10 characters) so accounts can book this correctly" },
      { status: 400 }
    );
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (proposal.payment_status === "paid") {
    return NextResponse.json({ error: "This payment is already marked as paid" }, { status: 400 });
  }

  // Shortfall tolerance, measured against the proposal's own total. Mirrors the
  // deposit rule: >10% short is a hard block, within 10% needs admin/manager
  // sign-off. Without it a part-payment could settle the whole obligation and
  // open the contract activation gate.
  const expectedAmount = Number(proposal.total_amount || 0);
  let shortfallApprovedById: string | null = null;

  if (expectedAmount > 0 && amount < expectedAmount) {
    const shortfallPct = (expectedAmount - amount) / expectedAmount;

    if (shortfallPct > 0.10) {
      const shortfallAmt = (expectedAmount - amount).toLocaleString("en-IN");
      return NextResponse.json(
        {
          error: `Amount is more than 10% below the expected ₹${expectedAmount.toLocaleString("en-IN")} (shortfall ₹${shortfallAmt}). Cannot record.`,
        },
        { status: 400 }
      );
    }

    const SHORTFALL_APPROVER_ROLES = ["admin", "manager"];
    if (!SHORTFALL_APPROVER_ROLES.includes(actor.role)) {
      return NextResponse.json(
        { error: "Only an admin or manager can approve a shortfall. Record the exact expected amount or ask a manager." },
        { status: 403 }
      );
    }

    if (!shortfallApproved) {
      return NextResponse.json(
        { error: "Shortfall approval is required. Check the approval box before submitting." },
        { status: 400 }
      );
    }

    shortfallApprovedById = actor.id;
  }

  // Upload proof if provided — non-fatal, the record is worth keeping either way.
  let screenshotUrl: string | null = null;
  if (proofFile && proofFile.size > 0) {
    const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `proposals/${id}/payment-proof-${Date.now()}.${ext}`;
    const buffer = Buffer.from(await proofFile.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(path, buffer, {
        contentType: proofFile.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error("[proposal-payment] storage upload error:", uploadError);
    } else {
      const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
      screenshotUrl = urlData?.publicUrl || null;
      if (!screenshotUrl) {
        const { data: signed } = await supabase.storage
          .from("crm-documents")
          .createSignedUrl(path, 60 * 60 * 24 * 365);
        screenshotUrl = signed?.signedUrl || null;
      }
    }
  }

  const receivedAt = new Date().toISOString();
  const paymentUpdate = {
    payment_status: "paid",
    payment_amount: amount,
    payment_reference: reference,
    payment_medium: paymentMedium,
    payment_received_at: receivedAt,
    payment_screenshot_url: screenshotUrl,
    payment_internal_notes: notes,
    payment_recorded_by: actor.id,
    ...(shortfallApprovedById ? { payment_shortfall_approved_by: shortfallApprovedById } : {}),
  };

  const { error: updateError } = await supabase
    .from("proposals")
    .update(paymentUpdate)
    .eq("id", id);

  if (updateError) {
    console.error("[proposal-payment] update error:", updateError);
    return NextResponse.json({ error: "Failed to update proposal" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: diffChanges(proposal, paymentUpdate),
  }).catch(() => {});

  // Surfaced by the dialog so the person recording knows the contract is now
  // activatable rather than having to go and find out.
  const depositSettled =
    proposal.deposit_payment_status === "paid" ||
    Number(proposal.security_deposit_months || 0) === 0;

  return NextResponse.json({
    message: "Payment recorded successfully",
    screenshot_url: screenshotUrl,
    deposit_settled: depositSettled,
  });
}
