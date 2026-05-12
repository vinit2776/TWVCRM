import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "pending"; // pending | deposited | all

  let query = supabase
    .from("vendor_bill_tds")
    .select(`
      id, bill_id, section_code, vendor_type, base_amount, tds_rate,
      tds_amount, pan_available, status, challan_id, period_month, period_year,
      created_at,
      bill:vendor_bills(bill_number, total_amount, invoice_number, invoice_date,
        vendor_id,
        vendor:procurement_vendors(id, name, pan_number)),
      challan:tds_challans(id, challan_ref, bsr_code, challan_serial, deposit_date),
      section:tds_sections(code, description, rate_company, rate_individual),
      creator:users!vendor_bill_tds_created_by_fkey(id, full_name)
    `)
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .order("created_at", { ascending: false });

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}
