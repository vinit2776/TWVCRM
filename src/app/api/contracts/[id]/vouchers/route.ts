import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("voucher_issuances")
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at)")
    .eq("contract_id", id)
    .order("seat_number", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch the contract — must be active
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (contractError || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (contract.status !== "active") {
    return NextResponse.json(
      { error: "Vouchers can only be issued for active contracts" },
      { status: 400 }
    );
  }

  const totalSeats: number = contract.seats;

  // Count existing issuances for this contract (not revoked)
  const { count: alreadyIssued } = await supabase
    .from("voucher_issuances")
    .select("*", { count: "exact", head: true })
    .eq("contract_id", id)
    .is("revoked_at", null);

  const issuedCount = alreadyIssued || 0;
  const remaining = totalSeats - issuedCount;

  if (remaining <= 0) {
    return NextResponse.json(
      { error: "All seats already have vouchers issued" },
      { status: 400 }
    );
  }

  // Fetch available vouchers (FIFO by uploaded_at)
  const { data: availableVouchers, error: fetchError } = await supabase
    .from("voucher_repository")
    .select("*")
    .eq("status", "available")
    .order("uploaded_at", { ascending: true })
    .limit(remaining);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!availableVouchers || availableVouchers.length < remaining) {
    return NextResponse.json(
      {
        error: `Not enough vouchers available. Need ${remaining}, but only ${availableVouchers?.length || 0} available.`,
      },
      { status: 400 }
    );
  }

  // Get user's DB ID
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const now = new Date().toISOString();
  const issuedVouchers = [];

  for (let i = 0; i < remaining; i++) {
    const voucher = availableVouchers[i];
    const seatNumber = issuedCount + i + 1;

    // Update voucher_repository: status → "issued"
    const { error: updateError } = await supabase
      .from("voucher_repository")
      .update({
        status: "issued",
        issued_at: now,
        expires_at: contract.end_date,
      })
      .eq("id", voucher.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Insert into voucher_issuances
    const { data: issuance, error: insertError } = await supabase
      .from("voucher_issuances")
      .insert({
        contract_id: id,
        voucher_id: voucher.id,
        lead_id: contract.lead_id,
        seat_number: seatNumber,
        issued_by: dbUser?.id,
        valid_from: contract.start_date,
        valid_until: contract.end_date,
      })
      .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at)")
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    issuedVouchers.push(issuance);
  }

  // Audit log
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        count: { old: null, new: issuedVouchers.length },
        contract_id: { old: null, new: id },
      },
    });
  }

  return NextResponse.json(
    {
      data: issuedVouchers,
      message: `${issuedVouchers.length} vouchers issued`,
    },
    { status: 201 }
  );
}
