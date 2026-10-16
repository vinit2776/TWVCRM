import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lean lookup for the Cmd+K palette. The full /api/leads list does a count, an
// overdue-follow-up scan and wide `*` + embed selects — far too heavy for type-ahead.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  // getClaims verifies the JWT locally (no Auth round-trip) when the project signs with
  // asymmetric keys, and falls back to a server check otherwise. Either way PostgREST
  // re-verifies the token and RLS applies to the query below.
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 80);
  if (raw.length < 2) return NextResponse.json({ data: [] });

  // Commas, parens and quotes are PostgREST `or()` syntax, and % _ \ are ilike wildcards —
  // left in, they make the filter error out (empty results) instead of matching literally.
  const term = raw.replace(/[,()"'\\%_*]/g, " ").replace(/\s+/g, " ").trim();
  if (term.length < 2) return NextResponse.json({ data: [] });
  const pattern = `%${term}%`;

  const { data, error } = await supabase
    .from("leads")
    .select("id, first_name, last_name, company, email")
    .is("archived_at", null)
    .or(
      [
        "first_name",
        "last_name",
        "email",
        "phone",
        "mobile",
        "company",
      ]
        .map((col) => `${col}.ilike.${pattern}`)
        .join(",")
    )
    .order("created_at", { ascending: false })
    .limit(6);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}
