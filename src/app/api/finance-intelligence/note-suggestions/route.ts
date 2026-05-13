import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  loadFinanceIntelligenceConfig,
  isFeatureEnabled,
} from "@/lib/finance-intelligence";

/**
 * GET /api/finance-intelligence/note-suggestions?vendor_id=&q=
 *
 * Returns up to 4 distinct past notes from the vendor's approved bills
 * that contain the query string (case-insensitive). Used by the Notes
 * field autocomplete chips in the new-bill form.
 *
 * - Only pulls from approved bills (rejected/pending notes are noise)
 * - Trims and deduplicates; empty notes excluded
 * - Ordered by most-recently-used first (so most relevant shows first)
 * - q is optional — if omitted, returns the 4 most recent distinct notes
 *   (useful for showing suggestions before the user starts typing)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const vendorId = searchParams.get("vendor_id");
  const q = searchParams.get("q")?.trim() ?? "";

  if (!vendorId) {
    return NextResponse.json({ error: "vendor_id is required" }, { status: 400 });
  }

  // Feature gate
  const config = await loadFinanceIntelligenceConfig(supabase);
  if (!isFeatureEnabled(config, "description_templates")) {
    return NextResponse.json({ suggestions: [] });
  }

  const { data } = await supabase
    .from("vendor_bills")
    .select("notes, invoice_date")
    .eq("vendor_id", vendorId)
    .eq("approval_status", "approved")
    .not("notes", "is", null)
    .not("notes", "eq", "")
    .order("invoice_date", { ascending: false })
    .limit(50);

  if (!data?.length) return NextResponse.json({ suggestions: [] });

  // Deduplicate (case-insensitive), filter by query, return top 4
  const seen = new Set<string>();
  const suggestions: string[] = [];

  for (const row of data) {
    const note = (row.notes as string).trim();
    if (!note) continue;
    const key = note.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (!q || key.includes(q.toLowerCase())) {
      suggestions.push(note);
    }
    if (suggestions.length >= 4) break;
  }

  return NextResponse.json({ suggestions });
}
