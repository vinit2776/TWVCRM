import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { RENT_PAYABLE_ROLES } from "@/lib/constants";

// GET — all approved (ready-to-pay) and recently paid rent payments
// Used by Finance > Rent Payable tab. Admin + accounts + viewer.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_PAYABLE_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "pending"; // pending | paid

  const query = supabase
    .from("lease_payments")
    .select(`
      id,
      payment_month,
      due_date,
      gross_rent_amount,
      tds_amount,
      net_amount_paid,
      status,
      on_hold_reason,
      admin_approved_by,
      admin_approved_at,
      paid_date,
      payment_mode,
      payment_reference,
      lease:property_leases (
        id,
        lease_number,
        approval_mode,
        location:locations (id, name),
        landlord:landlords (
          id, name, pan_number,
          bank_accounts:landlord_bank_accounts (
            id, bank_name, account_number, ifsc_code, account_holder_name, is_primary, is_verified
          )
        )
      )
    `)
    .order("due_date", { ascending: true });

  if (view === "paid") {
    query.eq("status", "paid").gte("paid_date", new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
  } else {
    query.in("status", ["approved", "on_hold"]);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Compute net payable = gross - tds for display
  const enriched = (data ?? []).map((p) => ({
    ...p,
    net_payable: (p.gross_rent_amount ?? 0) - (p.tds_amount ?? 0),
    primary_bank: Array.isArray((p.lease as { landlord?: { bank_accounts?: unknown[] } })?.landlord?.bank_accounts)
      ? ((p.lease as { landlord?: { bank_accounts?: Array<{ is_primary: boolean }> } })?.landlord?.bank_accounts ?? []).find((b) => b.is_primary) ?? null
      : null,
  }));

  return NextResponse.json({ data: enriched });
}
