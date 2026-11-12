import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { SETTLEMENT_VIEW_ROLES, SETTLEMENT_STATUSES } from "@/lib/exit-settlement";
import { customerLabel, normalizeSettlement } from "@/lib/exit-settlement-server";

/** GET /api/exit-settlements?status= — the Acc Payables list of exit settlements. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me || !(SETTLEMENT_VIEW_ROLES as readonly string[]).includes(me.role)) return NextResponse.json({ data: [] });

  const status = request.nextUrl.searchParams.get("status");
  let q = createAdminClient()
    .from("exit_settlements")
    .select("*, contract:contracts!exit_settlements_contract_id_fkey(contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company))")
    .order("created_at", { ascending: false })
    .limit(100);
  if (status && (SETTLEMENT_STATUSES as readonly string[]).includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((r) => {
    const { contract, ...rest } = r as Record<string, unknown> & { contract?: { contract_number: string; lead: { first_name: string | null; last_name: string | null; company: string | null } | null } | null };
    return { ...normalizeSettlement(rest), contract_number: contract?.contract_number ?? null, customer: customerLabel(contract?.lead) };
  });
  return NextResponse.json({ data: rows });
}
