import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getPettyCashPolicy } from "@/lib/petty-cash-policy-server";

/** GET /api/petty-cash/receipt-policy — the two amounts the screens explain to users. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await getPettyCashPolicy(createAdminClient()));
}
