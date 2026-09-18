import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getUnbilledQueue } from "@/lib/unbilled-queue";

/**
 * GET /api/billing/unbilled?type=rent
 *
 * Backs the Rentals and Usage tabs on /billing — one merged list across up
 * to four categories (current cycle ready to send, rent gap, renewal drift,
 * no renewal on file — the last three are rent-only, see unbilled-queue.ts).
 * Read-only; admin client because this spans contracts and leads regardless
 * of who's viewing, same pattern as usage-rollup.
 *
 * No pagination — realistic row counts for one operator don't need it.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Usage has its own grouped endpoint (/api/usage-billing/unbilled).
  if (request.nextUrl.searchParams.get("type") === "usage") {
    return NextResponse.json({ data: [], counts: {} });
  }

  const admin = createAdminClient();
  const { rows, counts } = await getUnbilledQueue(admin);
  return NextResponse.json({ data: rows, counts });
}
