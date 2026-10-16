import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/unsigned
 *
 * Ids of accepted/active contracts with no signed agreement attached, so the
 * contracts list can flag them. Separate from the list query because the
 * search RPC doesn't return signed_document_id. Read-only.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contracts")
    .select("id")
    .in("status", ["accepted", "active", "renewal_in_progress"])
    .is("signed_document_id", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: (data ?? []).map((c) => c.id as string) });
}
