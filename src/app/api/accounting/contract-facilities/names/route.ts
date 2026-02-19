import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get distinct facility names across all contracts for autocomplete
  const { data, error } = await supabase
    .from("contract_facilities")
    .select("name, unit")
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Deduplicate by name
  const seen = new Set<string>();
  const uniqueNames = (data || []).filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });

  return NextResponse.json({ data: uniqueNames });
}
