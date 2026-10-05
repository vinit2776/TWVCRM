import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

/**
 * Rent waivers — an admin marks a missed rent month as "not billed through the
 * CRM". The month drops off the rent-gap list and the contract page's missing
 * rent prompt; it can still be billed from the contract page, and a real
 * statement for the month always wins. See migration 00575.
 */

const CreateSchema = z.object({
  waived_month: z.string().regex(/^\d{4}-\d{2}-01$/, "Must be first of month (YYYY-MM-01)"),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters)"),
});

// GET /api/contracts/[id]/rent-waivers — live (un-revoked) waivers for a contract
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_rent_waivers")
    .select("id, waived_month, reason, waived_at, waived_by_user:users!contract_rent_waivers_waived_by_fkey(full_name)")
    .eq("contract_id", contractId)
    .is("revoked_at", null)
    .order("waived_month", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/contracts/[id]/rent-waivers — waive one month (admin only)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can waive billing" }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { waived_month, reason } = parsed.data;

  const { data: contract } = await admin
    .from("contracts").select("id, contract_number, start_date").eq("id", contractId).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // Only months that can actually be gaps: not before the contract's first
  // month, and not after the current month (future months aren't owed yet).
  const currentMonthFirst = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7) + "-01";
  if (waived_month < `${String(contract.start_date).slice(0, 7)}-01` || waived_month > currentMonthFirst) {
    return NextResponse.json({ error: "Only a past or current month within the contract can be waived" }, { status: 422 });
  }

  // A month that already has a rent statement isn't a gap — void/discard that instead.
  const [y, m] = waived_month.split("-").map(Number);
  const { data: covering } = await admin
    .from("billing_statements")
    .select("id")
    .eq("contract_id", contractId)
    .in("statement_type", ["rent", "combined"])
    .eq("prepaid_year", y)
    .eq("prepaid_month", m)
    .is("voided_at", null)
    .neq("status", "discarded")
    .limit(1);
  if ((covering ?? []).length > 0) {
    return NextResponse.json({ error: "This month already has a rent statement — nothing to waive" }, { status: 409 });
  }

  const { data: waiver, error } = await admin
    .from("contract_rent_waivers")
    .insert({ contract_id: contractId, waived_month, reason, waived_by: dbUser.id })
    .select("id, waived_month, reason, waived_at")
    .single();

  if (error) {
    // 23505 = the live-waiver unique index: this month is already waived.
    if (error.code === "23505") {
      return NextResponse.json({ error: "This month is already waived" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(admin, {
    entityType: "contract",
    entityId: contractId,
    action: "rent_month_waived",
    performedBy: dbUser.id,
    changes: { waived_month: { old: null, new: waived_month }, reason: { old: null, new: reason } },
  });

  return NextResponse.json(waiver, { status: 201 });
}
