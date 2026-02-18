import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/vouchers/[issuanceId]/replace
 * Replace a voucher after OTP verification
 * Body: { otp_id: string, otp_code: string, revoke_reason: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; issuanceId: string }> }
) {
  const { id, issuanceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { otp_id, otp_code, revoke_reason } = body as {
    otp_id: string;
    otp_code: string;
    revoke_reason: string;
  };

  if (!otp_id || !otp_code) {
    return NextResponse.json({ error: "OTP verification required" }, { status: 400 });
  }

  if (!revoke_reason) {
    return NextResponse.json({ error: "Revoke reason is required" }, { status: 400 });
  }

  // Step 1: Verify OTP
  const otpRes = await fetch(new URL("/api/admin/otp", request.url), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      cookie: request.headers.get("cookie") || "",
    },
    body: JSON.stringify({ otp_id, otp_code }),
  });

  const otpResult = await otpRes.json();

  if (!otpRes.ok || !otpResult.valid) {
    return NextResponse.json(
      { error: otpResult.reason || "OTP verification failed" },
      { status: 400 }
    );
  }

  // Verify reference_id matches this issuance
  if (otpResult.reference_id !== issuanceId) {
    return NextResponse.json(
      { error: "OTP reference does not match this issuance" },
      { status: 400 }
    );
  }

  // Step 2: Fetch the existing issuance
  const { data: oldIssuance, error: fetchError } = await supabase
    .from("voucher_issuances")
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, validity_days)")
    .eq("id", issuanceId)
    .eq("contract_id", id)
    .eq("is_active", true)
    .single();

  if (fetchError || !oldIssuance) {
    return NextResponse.json({ error: "Active issuance not found" }, { status: 404 });
  }

  // Fetch contract for validation
  const { data: contract } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Step 3: Find a replacement voucher from pool
  const validityDays = oldIssuance.voucher?.validity_days;

  if (!validityDays) {
    return NextResponse.json(
      { error: "Cannot determine voucher validity for replacement" },
      { status: 400 }
    );
  }

  let replaceQuery = supabase
    .from("voucher_repository")
    .select("*")
    .eq("status", "available")
    .eq("validity_days", validityDays);
  if (contract.location_id) replaceQuery = replaceQuery.eq("location_id", contract.location_id);
  replaceQuery = replaceQuery.order("uploaded_at", { ascending: true }).limit(1);

  const { data: replacementVouchers } = await replaceQuery;

  if (!replacementVouchers || replacementVouchers.length === 0) {
    return NextResponse.json(
      { error: "No replacement vouchers available in the pool. Please upload more vouchers first." },
      { status: 400 }
    );
  }

  const newVoucher = replacementVouchers[0];
  const now = new Date().toISOString();

  // Get DB user
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  // Step 4: Revoke old issuance
  const { error: revokeError } = await supabase
    .from("voucher_issuances")
    .update({
      is_active: false,
      revoked_at: now,
      revoke_reason: revoke_reason,
    })
    .eq("id", issuanceId);

  if (revokeError) {
    return NextResponse.json({ error: revokeError.message }, { status: 500 });
  }

  // Step 5: Revoke old voucher in repository
  await supabase
    .from("voucher_repository")
    .update({ status: "revoked" })
    .eq("id", oldIssuance.voucher_id);

  // Step 6: Mark new voucher as issued
  const { error: markError } = await supabase
    .from("voucher_repository")
    .update({
      status: "issued",
      issued_at: now,
      expires_at: contract.end_date,
    })
    .eq("id", newVoucher.id);

  if (markError) {
    return NextResponse.json({ error: markError.message }, { status: 500 });
  }

  // Step 7: Create new issuance
  const { data: newIssuance, error: insertError } = await supabase
    .from("voucher_issuances")
    .insert({
      contract_id: id,
      voucher_id: newVoucher.id,
      lead_id: oldIssuance.lead_id,
      seat_number: oldIssuance.seat_number,
      issued_by: dbUser?.id,
      valid_from: contract.start_date,
      valid_until: contract.end_date,
      seat_occupant_email: oldIssuance.seat_occupant_email,
      is_active: true,
      replaces_issuance_id: issuanceId,
    })
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Step 8: Audit log
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        action: { old: null, new: "replacement" },
        seat_number: { old: oldIssuance.seat_number, new: oldIssuance.seat_number },
        old_voucher_code: { old: oldIssuance.voucher?.voucher_code, new: null },
        new_voucher_code: { old: null, new: newVoucher.voucher_code },
        revoke_reason: { old: null, new: revoke_reason },
        old_issuance_id: { old: issuanceId, new: newIssuance.id },
      },
    });
  }

  return NextResponse.json({
    data: newIssuance,
    message: "Voucher replaced successfully",
    old_voucher_code: oldIssuance.voucher?.voucher_code,
    new_voucher_code: newVoucher.voucher_code,
  });
}
