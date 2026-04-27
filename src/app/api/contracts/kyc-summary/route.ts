import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/contracts/kyc-summary?ids=a,b,c
// Returns a per-contract count of required KYC document statuses.
// Used by the lead contracts tab to show compliance indicators without N+1 fetches.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const ids = searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
  if (ids.length === 0) return NextResponse.json({ data: {} });

  const { data, error } = await supabase
    .from("contract_documents")
    .select("contract_id, status")
    .in("contract_id", ids)
    .eq("is_required", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type StatusCounts = {
    deferred: number; pending: number; uploaded: number;
    approved: number; rejected: number; total: number;
  };
  const summary: Record<string, StatusCounts> = {};

  for (const row of data ?? []) {
    if (!summary[row.contract_id]) {
      summary[row.contract_id] = { deferred: 0, pending: 0, uploaded: 0, approved: 0, rejected: 0, total: 0 };
    }
    const key = row.status as keyof Omit<StatusCounts, "total">;
    if (key in summary[row.contract_id]) summary[row.contract_id][key]++;
    summary[row.contract_id].total++;
  }

  return NextResponse.json({ data: summary });
}
