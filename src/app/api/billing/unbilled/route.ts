import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getUnbilledQueue } from "@/lib/unbilled-queue";

/**
 * GET /api/billing/unbilled
 *
 * Backs the Unbilled tab on /billing — one merged list across all four
 * categories (current cycle ready to send, rent gap, renewal drift, no
 * renewal on file). Read-only; admin client because this spans contracts
 * and leads regardless of who's viewing, same pattern as usage-rollup.
 *
 * No pagination — realistic row counts for one operator don't need it.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { rows, counts } = await getUnbilledQueue(admin);
  return NextResponse.json({ data: rows, counts });
}
