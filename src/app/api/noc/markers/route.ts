import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { loadNocSettings } from "@/lib/noc/server";

/**
 * GET /api/noc/markers?contract_ids=a,b,c
 * A light summary of NOC orders per contract, for the chips on the contracts list. Empty when the feature is off.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const ids = (new URL(req.url).searchParams.get("contract_ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return NextResponse.json({ data: {} });
  if (!(await loadNocSettings(createAdminClient())).enabled) return NextResponse.json({ data: {} });

  const { data } = await supabase
    .from("noc_requests")
    .select("contract_id, status, purpose, location:locations!noc_requests_location_id_fkey(name)")
    .in("contract_id", ids)
    .neq("status", "void");
  const out: Record<string, { status: string; purpose: string; locationName: string | null }[]> = {};
  for (const r of data ?? []) {
    const loc = (Array.isArray(r.location) ? r.location[0] : r.location) as { name?: string } | null;
    (out[r.contract_id] ||= []).push({ status: r.status, purpose: r.purpose, locationName: loc?.name ?? null });
  }
  return NextResponse.json({ data: out });
}
