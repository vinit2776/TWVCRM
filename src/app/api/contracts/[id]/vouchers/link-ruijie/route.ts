/**
 * POST /api/contracts/[id]/vouchers/link-ruijie
 *
 * Manually link an already-issued Ruijie voucher (e.g. issued by IT before
 * this integration existed) to a contract seat. This is a lookup-and-confirm
 * flow, never a search or fuzzy match — staff must already know the exact
 * voucher code, having verified it against the customer's actual device.
 *
 * Body: { member_id?: string, seat_number: number, voucher_code: string, confirm?: boolean }
 *
 * Without `confirm`, returns a preview of the voucher's real details for staff
 * to visually confirm before anything is written. With `confirm: true`,
 * re-validates and writes the voucher_issuances row.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { findRuijieVoucherByCode, isRuijieLocation } from "@/lib/ruijie";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { member_id?: string; seat_number?: number; voucher_code?: string; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { member_id, seat_number: seatNumber, voucher_code: voucherCode, confirm } = body;

  if (!seatNumber || !voucherCode?.trim()) {
    return NextResponse.json({ error: "seat_number and voucher_code are required" }, { status: 400 });
  }

  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (contractError || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (contract.status !== "active") {
    return NextResponse.json({ error: "Vouchers can only be linked for active contracts" }, { status: 400 });
  }

  if (seatNumber < 1 || seatNumber > contract.seats) {
    return NextResponse.json({ error: `Seat number must be between 1 and ${contract.seats}` }, { status: 400 });
  }

  if (!contract.location_id) {
    return NextResponse.json({ error: "Contract has no location set" }, { status: 400 });
  }

  const { data: location } = await supabase
    .from("locations")
    .select("wifi_voucher_mode, ruijie_group_id")
    .eq("id", contract.location_id)
    .single();

  if (!location || !isRuijieLocation(location) || !location.ruijie_group_id) {
    return NextResponse.json({ error: "This location is not managed via the Ruijie API" }, { status: 400 });
  }

  // Seat must not already have an active voucher
  const { data: existingSeat } = await supabase
    .from("voucher_issuances")
    .select("id")
    .eq("contract_id", id)
    .eq("seat_number", seatNumber)
    .eq("is_active", true)
    .maybeSingle();

  if (existingSeat) {
    return NextResponse.json({ error: `Seat ${seatNumber} already has an active voucher` }, { status: 400 });
  }

  // Look up the voucher by exact code — never a fuzzy search
  let voucher;
  try {
    voucher = await findRuijieVoucherByCode(location.ruijie_group_id, voucherCode);
  } catch (err) {
    console.error("[link-ruijie] lookup failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach Ruijie Cloud" },
      { status: 502 }
    );
  }

  if (!voucher) {
    return NextResponse.json(
      { error: `No voucher with code "${voucherCode}" found for this location in Ruijie Cloud. Double-check the code.` },
      { status: 404 }
    );
  }

  // This exact voucher must not already be linked to a different active issuance
  const { data: alreadyLinked } = await supabase
    .from("voucher_issuances")
    .select("id, contract_id, seat_number")
    .eq("ruijie_voucher_uuid", voucher.uuid)
    .eq("is_active", true)
    .maybeSingle();

  if (alreadyLinked) {
    return NextResponse.json(
      { error: `This voucher is already linked to another contract/seat (contract ${alreadyLinked.contract_id}, seat ${alreadyLinked.seat_number}).` },
      { status: 400 }
    );
  }

  if (!confirm) {
    // Preview only — nothing written yet
    return NextResponse.json({ preview: voucher });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  let seatEmail: string | null = null;
  if (member_id) {
    const { data: member } = await supabase
      .from("members")
      .select("email")
      .eq("id", member_id)
      .maybeSingle();
    seatEmail = member?.email ?? null;
  }

  const { data: issuance, error: insertError } = await supabase
    .from("voucher_issuances")
    .insert({
      contract_id: id,
      voucher_id: null,
      member_id: member_id || null,
      lead_id: contract.lead_id || null,
      seat_number: seatNumber,
      issued_by: dbUser?.id,
      valid_from: contract.start_date,
      valid_until: contract.end_date,
      seat_occupant_email: seatEmail,
      is_active: true,
      ruijie_voucher_uuid: voucher.uuid,
      ruijie_code: voucher.code,
    })
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        seat_number: { old: null, new: seatNumber },
        ruijie_voucher_uuid: { old: null, new: voucher.uuid },
        ruijie_code: { old: null, new: voucher.code },
        mode: { old: null, new: "link_existing" },
      },
    });
  }

  return NextResponse.json({ data: issuance, message: "Existing voucher linked" }, { status: 201 });
}
