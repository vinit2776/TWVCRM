import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// vendor category → suggested TDS section (only for service context)
const CATEGORY_SECTION_MAP: Record<string, string> = {
  maintenance:    "194C",
  administration: "194J_b",
  general:        "194J_a",
  pantry:         "",        // no TDS on pantry
};

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const vendorId = searchParams.get("vendor_id");
  const poType   = searchParams.get("po_type");   // "goods" | "service" | null

  // Goods POs → no TDS
  if (poType === "goods") {
    return NextResponse.json({ tds_applicable: false, section_code: null });
  }

  if (!vendorId) {
    return NextResponse.json({ tds_applicable: false, section_code: null });
  }

  const { data: vendor } = await supabase
    .from("procurement_vendors")
    .select("category, pan_number")
    .eq("id", vendorId)
    .single();

  if (!vendor) {
    return NextResponse.json({ tds_applicable: false, section_code: null });
  }

  const sectionCode = CATEGORY_SECTION_MAP[vendor.category] ?? null;

  if (!sectionCode) {
    return NextResponse.json({ tds_applicable: false, section_code: null });
  }

  const { data: section } = await supabase
    .from("tds_sections")
    .select("*")
    .eq("code", sectionCode)
    .single();

  const panAvailable = !!(vendor.pan_number?.trim());
  // If PAN missing, rate defaults to 20% per section 206AA
  const effectiveRate = panAvailable
    ? section?.rate_company ?? null
    : 20;

  return NextResponse.json({
    tds_applicable: true,
    section_code:   sectionCode,
    section:        section ?? null,
    pan_available:  panAvailable,
    suggested_rate: effectiveRate,
  });
}
