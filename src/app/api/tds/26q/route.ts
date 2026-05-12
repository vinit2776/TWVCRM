import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/tds/26q?quarter=1&year=2026
// Returns JSON rows in 26Q deductee-wise format for Excel export
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
  const quarter = Number(searchParams.get("quarter") ?? 1);
  const year    = Number(searchParams.get("year") ?? new Date().getFullYear());

  if (quarter < 1 || quarter > 4) return NextResponse.json({ error: "quarter must be 1–4" }, { status: 400 });

  const quarterMonths: Record<number, number[]> = {
    1: [4, 5, 6],
    2: [7, 8, 9],
    3: [10, 11, 12],
    4: [1, 2, 3],
  };
  const months = quarterMonths[quarter];
  const calYear = quarter === 4 ? year + 1 : year;

  // Org settings
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["tds_tan_number", "tds_entity_name", "tds_entity_pan"]);
  const sm = Object.fromEntries((settings ?? []).map((s) => [s.key, s.value]));

  // All deposited TDS entries for the quarter
  const { data: entries, error } = await supabase
    .from("vendor_bill_tds")
    .select(`
      id, base_amount, tds_rate, tds_amount, pan_available, section_code,
      period_month, period_year,
      bill:vendor_bills(
        bill_number, invoice_date, vendor_id,
        vendor:procurement_vendors(id, name, pan_number)
      ),
      challan:tds_challans(challan_ref, bsr_code, challan_serial, deposit_date)
    `)
    .eq("status", "deposited")
    .in("period_month", months)
    .eq("period_year", calYear);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const fyLabel = `${year}-${String(year + 1).slice(2)}`;
  const quarterLabel = ["Q1 (Apr–Jun)", "Q2 (Jul–Sep)", "Q3 (Oct–Dec)", "Q4 (Jan–Mar)"][quarter - 1];

  const rows = (entries ?? []).map((e) => {
    const bill    = e.bill as { bill_number?: string; invoice_date?: string; vendor?: { name?: string; pan_number?: string } } | null;
    const challan = e.challan as { challan_ref?: string; bsr_code?: string; challan_serial?: string; deposit_date?: string } | null;
    return {
      deductor_tan:    sm.tds_tan_number  ?? "",
      deductor_name:   sm.tds_entity_name ?? "Sree Design Infrastructure Pvt Ltd",
      deductor_pan:    sm.tds_entity_pan  ?? "",
      fy:              fyLabel,
      quarter:         quarterLabel,
      deductee_pan:    bill?.vendor?.pan_number ?? (e.pan_available ? "" : "PANNOTAVBL"),
      deductee_name:   bill?.vendor?.name ?? "—",
      bill_number:     bill?.bill_number ?? "—",
      invoice_date:    bill?.invoice_date ?? "",
      section:         e.section_code,
      amount_paid:     Number(e.base_amount),
      tds_rate:        Number(e.tds_rate),
      tds_deducted:    Number(e.tds_amount),
      challan_bsr:     challan?.bsr_code ?? "",
      challan_serial:  challan?.challan_serial ?? "",
      deposit_date:    challan?.deposit_date ?? "",
      period_month:    e.period_month,
      period_year:     e.period_year,
    };
  });

  return NextResponse.json({ data: rows, meta: { fy: fyLabel, quarter: quarterLabel, total_rows: rows.length } });
}
