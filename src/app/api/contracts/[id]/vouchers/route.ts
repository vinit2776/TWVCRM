import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { isContractOperational } from "@/lib/constants";
import {
  createUnifiVoucher,
  siteConfigFromLocation,
  isUnifiLocation,
  calcVoucherMinutes,
} from "@/lib/unifi";
import {
  siteConfigFromLocation as ruijieSiteConfigFromLocation,
  isRuijieLocation,
  issueRuijieVoucherForContract,
} from "@/lib/ruijie";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const showHistory = request.nextUrl.searchParams.get("show_history") === "true";

  let query = supabase
    .from("voucher_issuances")
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
    .eq("contract_id", id);

  // By default only show active issuances; show_history includes revoked/replaced
  if (!showHistory) {
    query = query.eq("is_active", true);
  }

  query = query.order("seat_number", { ascending: true }).order("is_active", { ascending: false });

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse body — may contain per-seat params
  let body: { seat_number?: number; seat_occupant_email?: string; member_id?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body = bulk mode (backward compat)
  }

  const isPerSeatMode = typeof body.seat_number === "number";

  // Fetch the contract — must be active
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (contractError || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!isContractOperational(contract)) {
    return NextResponse.json(
      { error: "Vouchers can only be issued for active contracts" },
      { status: 400 }
    );
  }

  if (!contract.signed_document_id) {
    return NextResponse.json(
      { error: "A signed contract document must be uploaded before vouchers can be issued" },
      { status: 400 }
    );
  }

  const totalSeats: number = contract.seats;

  // Count existing ACTIVE issuances for this contract
  const { count: alreadyIssued } = await supabase
    .from("voucher_issuances")
    .select("*", { count: "exact", head: true })
    .eq("contract_id", id)
    .eq("is_active", true);

  const issuedCount = alreadyIssued || 0;

  // ── Fetch location to determine voucher mode ──────────────────────
  const locationId: string | null = contract.location_id || null;
  let useUnifi = false;
  let useRuijie = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let location: any = null;

  if (locationId) {
    const { data: loc } = await supabase
      .from("locations")
      .select("unifi_site_id, unifi_console_id, wifi_voucher_mode, ruijie_group_id, name")
      .eq("id", locationId)
      .single();
    location = loc;
    useUnifi = loc ? isUnifiLocation(loc) : false;
    useRuijie = loc ? isRuijieLocation(loc) : false;
  }

  // ──────────────────────────────────────────────────────────────────
  // UNIFI PATH
  // ──────────────────────────────────────────────────────────────────
  if (useUnifi) {
    const siteConfig = siteConfigFromLocation(location);
    const durationMinutes = calcVoucherMinutes(contract.end_date);

    const { data: dbUser } = await supabase
      .from("users")
      .select("id")
      .eq("auth_id", user.id)
      .single();

    if (isPerSeatMode) {
      const seatNumber = body.seat_number!;

      if (seatNumber < 1 || seatNumber > totalSeats) {
        return NextResponse.json(
          { error: `Seat number must be between 1 and ${totalSeats}` },
          { status: 400 }
        );
      }

      // Check if seat already has an active voucher
      const { data: existingSeat } = await supabase
        .from("voucher_issuances")
        .select("id")
        .eq("contract_id", id)
        .eq("seat_number", seatNumber)
        .eq("is_active", true)
        .maybeSingle();

      if (existingSeat) {
        return NextResponse.json(
          { error: `Seat ${seatNumber} already has an active voucher` },
          { status: 400 }
        );
      }

      let unifiId: string;
      let unifiCode: string;
      try {
        const result = await createUnifiVoucher(
          {
            durationMinutes,
            note: `${contract.contract_number}_seat${seatNumber}`,
            quota: 2,
          },
          siteConfig
        );
        unifiId = result.id;
        unifiCode = result.code;
      } catch (err) {
        console.error("[unifi] per-seat voucher creation failed:", err);
        return NextResponse.json(
          { error: "Failed to create Unifi voucher. Check API credentials and try again." },
          { status: 502 }
        );
      }

      const { data: issuance, error: insertError } = await supabase
        .from("voucher_issuances")
        .insert({
          contract_id: id,
          voucher_id: null,
          lead_id: contract.lead_id || null,
          seat_number: seatNumber,
          issued_by: dbUser?.id,
          valid_from: contract.start_date,
          valid_until: contract.end_date,
          seat_occupant_email: body.seat_occupant_email || null,
          member_id: body.member_id || null,
          is_active: true,
          unifi_voucher_id: unifiId,
          unifi_code: unifiCode,
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
            unifi_voucher_id: { old: null, new: unifiId },
            unifi_code: { old: null, new: unifiCode },
          },
        });
      }

      return NextResponse.json(
        {
          data: [issuance],
          message: "1 Unifi voucher issued",
          unifi_code: unifiCode,
        },
        { status: 201 }
      );
    }

    // Bulk Unifi mode: issue for all remaining seats
    const remaining = totalSeats - issuedCount;

    if (remaining <= 0) {
      return NextResponse.json(
        { error: "All seats already have vouchers issued" },
        { status: 400 }
      );
    }

    // Find which seat numbers are already active
    const { data: activeIssuances } = await supabase
      .from("voucher_issuances")
      .select("seat_number")
      .eq("contract_id", id)
      .eq("is_active", true);

    const activeSeatNumbers = new Set((activeIssuances || []).map((i) => i.seat_number));
    const unfilledSeats: number[] = [];
    for (let s = 1; s <= totalSeats; s++) {
      if (!activeSeatNumbers.has(s)) unfilledSeats.push(s);
    }

    const issuedVouchers = [];
    const issuedCodes: string[] = [];

    for (const seatNumber of unfilledSeats) {
      let unifiId: string;
      let unifiCode: string;
      try {
        const result = await createUnifiVoucher(
          {
            durationMinutes,
            note: `${contract.contract_number}_seat${seatNumber}`,
            quota: 2,
          },
          siteConfig
        );
        unifiId = result.id;
        unifiCode = result.code;
      } catch (err) {
        console.error(`[unifi] seat ${seatNumber} voucher creation failed:`, err);
        return NextResponse.json(
          { error: `Failed to create Unifi voucher for seat ${seatNumber}. ${issuedVouchers.length} vouchers issued before failure.` },
          { status: 502 }
        );
      }

      const { data: issuance, error: insertError } = await supabase
        .from("voucher_issuances")
        .insert({
          contract_id: id,
          voucher_id: null,
          lead_id: contract.lead_id || null,
          seat_number: seatNumber,
          issued_by: dbUser?.id,
          valid_from: contract.start_date,
          valid_until: contract.end_date,
          is_active: true,
          unifi_voucher_id: unifiId,
          unifi_code: unifiCode,
        })
        .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
        .single();

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      issuedVouchers.push(issuance);
      issuedCodes.push(unifiCode);
    }

    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "voucher",
        entityId: id,
        action: "create",
        performedBy: dbUser.id,
        changes: {
          count: { old: null, new: issuedVouchers.length },
          contract_id: { old: null, new: id },
          mode: { old: null, new: "unifi_api" },
        },
      });
    }

    return NextResponse.json(
      {
        data: issuedVouchers,
        message: `${issuedVouchers.length} Unifi vouchers issued`,
        unifi_codes: issuedCodes,
      },
      { status: 201 }
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // RUIJIE PATH
  // ──────────────────────────────────────────────────────────────────
  if (useRuijie) {
    const siteConfig = ruijieSiteConfigFromLocation(location);
    if (!siteConfig) {
      return NextResponse.json(
        { error: "This location is set to Ruijie voucher mode but has no ruijie_group_id configured." },
        { status: 400 }
      );
    }

    const tenureMonths: number = contract.tenure_months || 1;
    const targetDays = tenureMonths * 30;

    const { data: dbUser } = await supabase
      .from("users")
      .select("id")
      .eq("auth_id", user.id)
      .single();

    if (isPerSeatMode) {
      const seatNumber = body.seat_number!;

      if (seatNumber < 1 || seatNumber > totalSeats) {
        return NextResponse.json(
          { error: `Seat number must be between 1 and ${totalSeats}` },
          { status: 400 }
        );
      }

      const { data: existingSeat } = await supabase
        .from("voucher_issuances")
        .select("id")
        .eq("contract_id", id)
        .eq("seat_number", seatNumber)
        .eq("is_active", true)
        .maybeSingle();

      if (existingSeat) {
        return NextResponse.json(
          { error: `Seat ${seatNumber} already has an active voucher` },
          { status: 400 }
        );
      }

      const issued = await issueRuijieVoucherForContract(
        siteConfig,
        targetDays,
        `${contract.contract_number}_seat${seatNumber}`
      );

      if ("error" in issued) {
        return NextResponse.json({ error: issued.error }, { status: 400 });
      }

      const { data: issuance, error: insertError } = await supabase
        .from("voucher_issuances")
        .insert({
          contract_id: id,
          voucher_id: null,
          lead_id: contract.lead_id || null,
          seat_number: seatNumber,
          issued_by: dbUser?.id,
          valid_from: contract.start_date,
          valid_until: contract.end_date,
          seat_occupant_email: body.seat_occupant_email || null,
          member_id: body.member_id || null,
          is_active: true,
          ruijie_voucher_uuid: issued.result.uuid,
          ruijie_code: issued.result.code,
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
            ruijie_voucher_uuid: { old: null, new: issued.result.uuid },
            ruijie_code: { old: null, new: issued.result.code },
          },
        });
      }

      return NextResponse.json(
        {
          data: [issuance],
          message: "1 Ruijie voucher issued",
          ruijie_code: issued.result.code,
          match_warning: issued.matchWarning,
        },
        { status: 201 }
      );
    }

    // Bulk Ruijie mode: issue for all remaining seats
    const remaining = totalSeats - issuedCount;

    if (remaining <= 0) {
      return NextResponse.json(
        { error: "All seats already have vouchers issued" },
        { status: 400 }
      );
    }

    const { data: activeIssuances } = await supabase
      .from("voucher_issuances")
      .select("seat_number")
      .eq("contract_id", id)
      .eq("is_active", true);

    const activeSeatNumbers = new Set((activeIssuances || []).map((i) => i.seat_number));
    const unfilledSeats: number[] = [];
    for (let s = 1; s <= totalSeats; s++) {
      if (!activeSeatNumbers.has(s)) unfilledSeats.push(s);
    }

    const issuedVouchers = [];
    const issuedCodes: string[] = [];
    let lastMatchWarning: string | null = null;

    for (const seatNumber of unfilledSeats) {
      const issued = await issueRuijieVoucherForContract(
        siteConfig,
        targetDays,
        `${contract.contract_number}_seat${seatNumber}`
      );

      if ("error" in issued) {
        return NextResponse.json(
          { error: `${issued.error} ${issuedVouchers.length} vouchers issued before failure.` },
          { status: 400 }
        );
      }

      const { data: issuance, error: insertError } = await supabase
        .from("voucher_issuances")
        .insert({
          contract_id: id,
          voucher_id: null,
          lead_id: contract.lead_id || null,
          seat_number: seatNumber,
          issued_by: dbUser?.id,
          valid_from: contract.start_date,
          valid_until: contract.end_date,
          is_active: true,
          ruijie_voucher_uuid: issued.result.uuid,
          ruijie_code: issued.result.code,
        })
        .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
        .single();

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      issuedVouchers.push(issuance);
      issuedCodes.push(issued.result.code);
      lastMatchWarning = issued.matchWarning;
    }

    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "voucher",
        entityId: id,
        action: "create",
        performedBy: dbUser.id,
        changes: {
          count: { old: null, new: issuedVouchers.length },
          contract_id: { old: null, new: id },
          mode: { old: null, new: "ruijie_api" },
        },
      });
    }

    return NextResponse.json(
      {
        data: issuedVouchers,
        message: `${issuedVouchers.length} Ruijie vouchers issued`,
        ruijie_codes: issuedCodes,
        match_warning: lastMatchWarning,
      },
      { status: 201 }
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // REPOSITORY PATH (existing logic)
  // ──────────────────────────────────────────────────────────────────

  // Per-seat mode: issue 1 voucher for a specific seat
  if (isPerSeatMode) {
    const seatNumber = body.seat_number!;

    if (seatNumber < 1 || seatNumber > totalSeats) {
      return NextResponse.json(
        { error: `Seat number must be between 1 and ${totalSeats}` },
        { status: 400 }
      );
    }

    // Check if seat already has an active voucher
    const { data: existingSeat } = await supabase
      .from("voucher_issuances")
      .select("id")
      .eq("contract_id", id)
      .eq("seat_number", seatNumber)
      .eq("is_active", true)
      .maybeSingle();

    if (existingSeat) {
      return NextResponse.json(
        { error: `Seat ${seatNumber} already has an active voucher` },
        { status: 400 }
      );
    }

    // Issue 1 voucher using smart validity matching
    const voucher = await findAndIssueOneVoucher(supabase, contract, id, seatNumber, body.seat_occupant_email, user.id, locationId, body.member_id);

    if ("error" in voucher) {
      return NextResponse.json({ error: voucher.error }, { status: voucher.status || 400 });
    }

    return NextResponse.json(
      {
        data: [voucher.data],
        message: "1 voucher issued",
        matched_validity_days: voucher.matched_validity_days,
        match_warning: voucher.match_warning,
      },
      { status: 201 }
    );
  }

  // Bulk mode: issue for all remaining seats
  const remaining = totalSeats - issuedCount;

  if (remaining <= 0) {
    return NextResponse.json(
      { error: "All seats already have vouchers issued" },
      { status: 400 }
    );
  }

  // ===== Smart Validity Matching with Duration Enforcement =====
  const tenureMonths: number = contract.tenure_months || 1;
  const targetDays = tenureMonths * 30;
  const TOLERANCE = 0.20;
  const minAcceptable = Math.floor(targetDays * (1 - TOLERANCE));
  const maxAcceptable = Math.ceil(targetDays * (1 + TOLERANCE));

  let availQuery = supabase
    .from("voucher_repository")
    .select("validity_days")
    .eq("status", "available")
    .not("validity_days", "is", null);
  if (locationId) availQuery = availQuery.eq("location_id", locationId);

  const { data: availabilityGroups, error: groupError } = await availQuery;

  if (groupError) {
    return NextResponse.json({ error: groupError.message }, { status: 500 });
  }

  const groupCounts = new Map<number, number>();
  for (const row of availabilityGroups || []) {
    if (row.validity_days != null) {
      groupCounts.set(row.validity_days, (groupCounts.get(row.validity_days) || 0) + 1);
    }
  }

  const formatDays = (d: number) => {
    if (d % 365 === 0 && d >= 365) return `${d / 365} year${d / 365 > 1 ? "s" : ""} (${d}d)`;
    if (d % 30 === 0 && d >= 30) return `${d / 30} month${d / 30 > 1 ? "s" : ""} (${d}d)`;
    return `${d} day${d !== 1 ? "s" : ""}`;
  };

  let matchedValidity: number | null = null;
  let matchWarning: string | null = null;

  if (groupCounts.size > 0) {
    const withinTolerance = Array.from(groupCounts.entries())
      .filter(([days]) => days >= minAcceptable && days <= maxAcceptable);

    const sortedGroups = withinTolerance
      .filter(([, count]) => count >= remaining)
      .sort(([a], [b]) => {
        const distA = Math.abs(a - targetDays);
        const distB = Math.abs(b - targetDays);
        if (distA !== distB) return distA - distB;
        return b - a;
      });

    if (sortedGroups.length > 0) {
      matchedValidity = sortedGroups[0][0];
      if (matchedValidity !== targetDays) {
        matchWarning = `Exact ${formatDays(targetDays)} vouchers not available. Using closest match: ${formatDays(matchedValidity)} vouchers.`;
      }
    } else if (withinTolerance.length > 0) {
      const bestMatch = withinTolerance.sort(([a], [b]) => Math.abs(a - targetDays) - Math.abs(b - targetDays))[0];
      return NextResponse.json(
        { error: `Not enough ${formatDays(bestMatch[0])} vouchers. Only ${bestMatch[1]} available, need ${remaining}. Upload more vouchers matching this contract's ${tenureMonths}-month tenure.` },
        { status: 400 }
      );
    } else {
      const availableGroups = Array.from(groupCounts.entries()).map(([days, count]) => `${formatDays(days)}: ${count} available`).join(", ");
      return NextResponse.json(
        { error: `No vouchers matching the contract duration of ${formatDays(targetDays)} (tolerance: ${formatDays(minAcceptable)}–${formatDays(maxAcceptable)}). Available voucher types: ${availableGroups || "none"}. Please upload vouchers with the correct validity period.` },
        { status: 400 }
      );
    }
  } else {
    return NextResponse.json(
      { error: `No vouchers with a validity period found in the repository. Please upload vouchers matching this contract's ${tenureMonths}-month (${formatDays(targetDays)}) tenure.` },
      { status: 400 }
    );
  }

  let grabQuery = supabase
    .from("voucher_repository")
    .select("*")
    .eq("status", "available")
    .eq("validity_days", matchedValidity);
  if (locationId) grabQuery = grabQuery.eq("location_id", locationId);
  grabQuery = grabQuery.order("uploaded_at", { ascending: true }).limit(remaining);

  const { data: availableVouchers, error: fetchError } = await grabQuery;

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!availableVouchers || availableVouchers.length < remaining) {
    return NextResponse.json(
      { error: `Not enough vouchers available. Need ${remaining}, but only ${availableVouchers?.length || 0} available in the ${formatDays(matchedValidity!)} group.` },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const now = new Date().toISOString();
  const issuedVouchers = [];

  // Find which seat numbers are already active
  const { data: activeIssuances } = await supabase
    .from("voucher_issuances")
    .select("seat_number")
    .eq("contract_id", id)
    .eq("is_active", true);

  const activeSeatNumbers = new Set((activeIssuances || []).map((i) => i.seat_number));

  // Find unfilled seat numbers
  const unfilledSeats: number[] = [];
  for (let s = 1; s <= totalSeats; s++) {
    if (!activeSeatNumbers.has(s)) unfilledSeats.push(s);
  }

  for (let i = 0; i < Math.min(remaining, unfilledSeats.length); i++) {
    const voucher = availableVouchers[i];
    const seatNumber = unfilledSeats[i];

    const { error: updateError } = await supabase
      .from("voucher_repository")
      .update({ status: "issued", issued_at: now, expires_at: contract.end_date })
      .eq("id", voucher.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

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
        is_active: true,
      })
      .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    issuedVouchers.push(issuance);
  }

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

// ===== Helper: Issue 1 repository voucher for a specific seat =====
/* eslint-disable @typescript-eslint/no-explicit-any */
async function findAndIssueOneVoucher(
  supabase: any,
  contract: any,
  contractId: string,
  seatNumber: number,
  seatOccupantEmail: string | undefined,
  authUserId: string,
  locationId: string | null,
  memberId?: string
) {
/* eslint-enable @typescript-eslint/no-explicit-any */
  const tenureMonths: number = contract.tenure_months || 1;
  const targetDays = tenureMonths * 30;
  const TOLERANCE = 0.20;
  const minAcceptable = Math.floor(targetDays * (1 - TOLERANCE));
  const maxAcceptable = Math.ceil(targetDays * (1 + TOLERANCE));

  const formatDays = (d: number) => {
    if (d % 365 === 0 && d >= 365) return `${d / 365} year${d / 365 > 1 ? "s" : ""} (${d}d)`;
    if (d % 30 === 0 && d >= 30) return `${d / 30} month${d / 30 > 1 ? "s" : ""} (${d}d)`;
    return `${d} day${d !== 1 ? "s" : ""}`;
  };

  // Find available voucher with matching validity
  let availQ = supabase
    .from("voucher_repository")
    .select("validity_days")
    .eq("status", "available")
    .not("validity_days", "is", null);
  if (locationId) availQ = availQ.eq("location_id", locationId);

  const { data: availabilityGroups } = await availQ;

  const groupCounts = new Map<number, number>();
  for (const row of availabilityGroups || []) {
    if (row.validity_days != null) {
      groupCounts.set(row.validity_days, (groupCounts.get(row.validity_days) || 0) + 1);
    }
  }

  if (groupCounts.size === 0) {
    return { error: `No vouchers available. Upload vouchers matching ${tenureMonths}-month tenure.`, status: 400 };
  }

  const withinTolerance = Array.from(groupCounts.entries())
    .filter(([days]) => days >= minAcceptable && days <= maxAcceptable);

  const sortedGroups = withinTolerance
    .filter(([, count]) => count >= 1)
    .sort(([a], [b]) => {
      const distA = Math.abs(a - targetDays);
      const distB = Math.abs(b - targetDays);
      if (distA !== distB) return distA - distB;
      return b - a;
    });

  if (sortedGroups.length === 0) {
    return { error: `No compatible vouchers for ${formatDays(targetDays)} tenure.`, status: 400 };
  }

  const matchedValidity = sortedGroups[0][0];
  const matchWarning = matchedValidity !== targetDays
    ? `Using closest match: ${formatDays(matchedValidity)} vouchers.`
    : null;

  // Grab 1 voucher
  let grabQ = supabase
    .from("voucher_repository")
    .select("*")
    .eq("status", "available")
    .eq("validity_days", matchedValidity);
  if (locationId) grabQ = grabQ.eq("location_id", locationId);
  grabQ = grabQ.order("uploaded_at", { ascending: true }).limit(1);

  const { data: vouchers } = await grabQ;

  if (!vouchers || vouchers.length === 0) {
    return { error: "No vouchers available", status: 400 };
  }

  const voucher = vouchers[0];
  const now = new Date().toISOString();

  // Get DB user
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", authUserId)
    .single();

  // Mark voucher as issued
  const { error: updateError } = await supabase
    .from("voucher_repository")
    .update({ status: "issued", issued_at: now, expires_at: contract.end_date })
    .eq("id", voucher.id);

  if (updateError) {
    return { error: updateError.message, status: 500 };
  }

  // Create issuance
  const { data: issuance, error: insertError } = await supabase
    .from("voucher_issuances")
    .insert({
      contract_id: contractId,
      voucher_id: voucher.id,
      lead_id: contract.lead_id,
      seat_number: seatNumber,
      issued_by: dbUser?.id,
      valid_from: contract.start_date,
      valid_until: contract.end_date,
      seat_occupant_email: seatOccupantEmail || null,
      member_id: memberId || null,
      is_active: true,
    })
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)")
    .single();

  if (insertError) {
    return { error: insertError.message, status: 500 };
  }

  // Audit
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: contractId,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        seat_number: { old: null, new: seatNumber },
        seat_occupant_email: { old: null, new: seatOccupantEmail || null },
      },
    });
  }

  return { data: issuance, matched_validity_days: matchedValidity, match_warning: matchWarning };
}
