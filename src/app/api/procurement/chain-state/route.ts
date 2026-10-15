import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getChainState } from "@/lib/procurement/chain-lock";

/**
 * GET /api/procurement/chain-state?bill_id=… | po_id=… | pr_id=…
 * Whether the procurement cycle a bill / PO / MR belongs to is open, closing or
 * locked, with the checklist behind it. Read-only; any signed-in user (the lock
 * banner shows on pages everyone can open).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const ref = { billId: sp.get("bill_id") ?? undefined, poId: sp.get("po_id") ?? undefined, prId: sp.get("pr_id") ?? undefined };
  if (!ref.billId && !ref.poId && !ref.prId) {
    return NextResponse.json({ error: "bill_id, po_id or pr_id is required" }, { status: 400 });
  }

  const found = await getChainState(supabase, ref);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Who reopened it last, for the banner.
  const { data: lastReopen } = await supabase
    .from("procurement_chain_reopens")
    .select("reopened_at, reason, reopener:users!procurement_chain_reopens_reopened_by_fkey(full_name)")
    .eq("root_type", found.root.type)
    .eq("root_id", found.root.id)
    .order("reopened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ data: { root: found.root, ...found.chain, lastReopen: lastReopen ?? null } });
}
