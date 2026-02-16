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
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
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

  // ===== Smart Validity Matching =====
  // Calculate target days from contract tenure
  const tenureMonths: number = contract.tenure_months || 1;
  const targetDays = tenureMonths * 30;

  // Find available validity groups with counts
  const { data: availabilityGroups, error: groupError } = await supabase
    .from("voucher_repository")
    .select("validity_days")
    .eq("status", "available")
    .not("validity_days", "is", null);

  if (groupError) {
    return NextResponse.json({ error: groupError.message }, { status: 500 });
  }

  // Count available vouchers per validity group
  const groupCounts = new Map<number, number>();
  for (const row of availabilityGroups || []) {
    if (row.validity_days != null) {
      groupCounts.set(
        row.validity_days,
        (groupCounts.get(row.validity_days) || 0) + 1
      );
    }
  }

  // Find the closest validity group that has enough vouchers
  let matchedValidity: number | null = null;
  let matchWarning: string | null = null;

  if (groupCounts.size > 0) {
    // Sort groups by distance from target, preferring >= target when equidistant
    const sortedGroups = Array.from(groupCounts.entries())
      .filter(([, count]) => count >= remaining)
      .sort(([a], [b]) => {
        const distA = Math.abs(a - targetDays);
        const distB = Math.abs(b - targetDays);
        if (distA !== distB) return distA - distB;
        // Prefer >= target when equidistant
        return b - a;
      });

    if (sortedGroups.length > 0) {
      matchedValidity = sortedGroups[0][0];
      if (matchedValidity !== targetDays) {
        matchWarning = `Exact ${targetDays}d vouchers not available. Using closest match: ${matchedValidity}d vouchers.`;
      }
    } else {
      // No single group has enough, try any group
      const anyGroupSorted = Array.from(groupCounts.entries())
        .sort(([a], [b]) => {
          const distA = Math.abs(a - targetDays);
          const distB = Math.abs(b - targetDays);
          if (distA !== distB) return distA - distB;
          return b - a;
        });

      if (anyGroupSorted.length > 0) {
        matchedValidity = anyGroupSorted[0][0];
        matchWarning = `Not enough ${matchedValidity}d vouchers. Only ${anyGroupSorted[0][1]} available, need ${remaining}.`;
      }
    }
  }

  // Build the query for available vouchers
  let voucherQuery = supabase
    .from("voucher_repository")
    .select("*")
    .eq("status", "available")
    .order("uploaded_at", { ascending: true })
    .limit(remaining);

  // Apply validity filter if we found a match
  if (matchedValidity !== null) {
    voucherQuery = voucherQuery.eq("validity_days", matchedValidity);
  }

  const { data: availableVouchers, error: fetchError } = await voucherQuery;

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!availableVouchers || availableVouchers.length < remaining) {
    return NextResponse.json(
      {
        error: `Not enough vouchers available. Need ${remaining}, but only ${availableVouchers?.length || 0} available${matchedValidity !== null ? ` (${matchedValidity}d group)` : ""}.`,
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

    // Update voucher_repository: status -> "issued"
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
      .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
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
        matched_validity_days: { old: null, new: matchedValidity },
      },
    });
  }

  return NextResponse.json(
    {
      data: issuedVouchers,
      message: `${issuedVouchers.length} vouchers issued`,
      matched_validity_days: matchedValidity,
      match_warning: matchWarning,
    },
    { status: 201 }
  );
}
