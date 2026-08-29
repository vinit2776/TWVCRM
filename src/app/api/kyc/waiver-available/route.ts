import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { waiverColumnsPresent } from "@/lib/kyc-waiver";

/**
 * GET /api/kyc/waiver-available — whether the waiver columns exist yet.
 *
 * The document tabs call this to decide whether to offer "Waive", so a merged
 * deploy whose migration has not been applied hides the action rather than
 * showing a button that always errors.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ data: { available: await waiverColumnsPresent() } });
}
