import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Returns the raw data needed to render Form 16A
// GET /api/tds/form16a?vendor_id=&quarter=1&year=2026
// quarter: 1=Apr-Jun, 2=Jul-Sep, 3=Oct-Dec, 4=Jan-Mar
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const vendorId = searchParams.get("vendor_id");
  const quarter  = Number(searchParams.get("quarter") ?? 1);  // 1–4
  const year     = Number(searchParams.get("year") ?? new Date().getFullYear());

  if (!vendorId) return NextResponse.json({ error: "vendor_id required" }, { status: 400 });
  if (quarter < 1 || quarter > 4) return NextResponse.json({ error: "quarter must be 1–4" }, { status: 400 });

  // Quarter month ranges (FY basis)
  const quarterMonths: Record<number, number[]> = {
    1: [4, 5, 6],    // Q1: Apr–Jun
    2: [7, 8, 9],    // Q2: Jul–Sep
    3: [10, 11, 12], // Q3: Oct–Dec
    4: [1, 2, 3],    // Q4: Jan–Mar
  };
  const months = quarterMonths[quarter];
  // Q4 spans into next calendar year
  const calYear = quarter === 4 ? year + 1 : year;
  const calYearAlt = quarter === 4 ? year : null; // Jan-Mar uses year+1, but Oct-Dec still uses year

  // Fetch org settings (TAN, entity name)
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["tds_tan_number", "tds_entity_name", "tds_entity_pan"]);

  const settingsMap = Object.fromEntries((settings ?? []).map((s) => [s.key, s.value]));

  // Fetch vendor
  const { data: vendor } = await supabase
    .from("procurement_vendors")
    .select("id, name, pan_number, contact_email, contact_name")
    .eq("id", vendorId)
    .single();

  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  // Fetch TDS entries for this vendor + quarter (deposited only — needs challan for Form 16A)
  let query = supabase
    .from("vendor_bill_tds")
    .select(`
      id, base_amount, tds_rate, tds_amount, period_month, period_year, section_code,
      bill:vendor_bills(bill_number, invoice_date, vendor_id),
      challan:tds_challans(id, challan_ref, bsr_code, challan_serial, deposit_date, section_code)
    `)
    .eq("status", "deposited")
    .in("period_month", months);

  // For Q4 (Jan-Mar), year stored in period_year will be the next calendar year
  if (quarter === 4) {
    query = query.eq("period_year", calYear);
  } else {
    query = query.eq("period_year", year);
  }

  const { data: allEntries } = await query;

  // Filter to entries for this vendor via the bill relationship
  const entries = (allEntries ?? []).filter(
    (e) => (e.bill as { vendor_id?: string } | null)?.vendor_id === vendorId
  );

  const totalPaid   = entries.reduce((s, e) => s + Number(e.base_amount), 0);
  const totalTds    = entries.reduce((s, e) => s + Number(e.tds_amount), 0);

  // FY label e.g. "2025-26"
  const fyLabel = `${year}-${String(year + 1).slice(2)}`;
  const quarterLabel = ["Q1 (Apr–Jun)", "Q2 (Jul–Sep)", "Q3 (Oct–Dec)", "Q4 (Jan–Mar)"][quarter - 1];

  return NextResponse.json({
    data: {
      deductor: {
        tan:  settingsMap.tds_tan_number  ?? "",
        name: settingsMap.tds_entity_name ?? "Sree Design Infrastructure Pvt Ltd",
        pan:  settingsMap.tds_entity_pan  ?? "",
      },
      deductee: {
        pan:   vendor.pan_number ?? "",
        name:  vendor.name,
        email: vendor.contact_email ?? "",
      },
      quarter: quarterLabel,
      fy: fyLabel,
      year,
      entries: entries.map((e) => ({
        bill_number:    (e.bill as { bill_number?: string } | null)?.bill_number ?? "—",
        invoice_date:   (e.bill as { invoice_date?: string } | null)?.invoice_date ?? null,
        base_amount:    Number(e.base_amount),
        tds_rate:       Number(e.tds_rate),
        tds_amount:     Number(e.tds_amount),
        section_code:   e.section_code,
        period_month:   e.period_month,
        period_year:    e.period_year,
        challan_ref:    (e.challan as { challan_ref?: string } | null)?.challan_ref ?? null,
        bsr_code:       (e.challan as { bsr_code?: string } | null)?.bsr_code ?? null,
        challan_serial: (e.challan as { challan_serial?: string } | null)?.challan_serial ?? null,
        deposit_date:   (e.challan as { deposit_date?: string } | null)?.deposit_date ?? null,
      })),
      totals: { total_paid: totalPaid, total_tds: totalTds },
    },
  });
}
