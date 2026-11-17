import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/deposit-refunds — walk-away deposit refunds for the Acc Payables panel. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).maybeSingle();
  if (!me || !["admin", "manager", "sales_rep", "accounts"].includes(me.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { data } = await createAdminClient()
    .from("proposal_deposit_refunds")
    .select(`*, proposal:proposals!proposal_deposit_refunds_proposal_id_fkey(proposal_number, lead:leads!proposals_lead_id_fkey(first_name, last_name, company))`)
    .neq("status", "rejected")
    .order("requested_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ data: data ?? [] });
}
