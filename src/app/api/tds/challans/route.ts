import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const createChallanSchema = z.object({
  bsr_code: z.string().length(7, "BSR code must be 7 digits"),
  challan_serial: z.string().min(1).max(10),
  deposit_date: z.string().min(1),
  period_month: z.number().int().min(1).max(12),
  period_year: z.number().int().min(2020),
  section_code: z.string().min(1),
  total_amount: z.number().positive(),
  tds_entry_ids: z.array(z.string().uuid()).min(1),
  receipt_url: z.string().nullish(),
  notes: z.string().nullish(),
});

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
  const year = searchParams.get("year");
  const month = searchParams.get("month");

  let query = supabase
    .from("tds_challans")
    .select(`
      id, challan_ref, bsr_code, challan_serial, deposit_date,
      period_month, period_year, section_code, total_amount,
      receipt_url, notes, created_at,
      depositor:users!tds_challans_deposited_by_fkey(id, full_name),
      section:tds_sections(code, description)
    `)
    .order("deposit_date", { ascending: false });

  if (year) query = query.eq("period_year", Number(year));
  if (month) query = query.eq("period_month", Number(month));

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createChallanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const d = parsed.data;

  // Generate sequential challan_ref: TDSC-YYMM-NNN
  const monthStr = String(d.period_month).padStart(2, "0");
  const prefix = `TDSC-${d.period_year}${monthStr}`;
  const { count } = await supabase
    .from("tds_challans")
    .select("*", { count: "exact", head: true })
    .like("challan_ref", `${prefix}%`);
  const seq = String((count ?? 0) + 1).padStart(3, "0");
  const challanRef = `${prefix}-${seq}`;

  // Insert challan
  const { data: challan, error: challanError } = await supabase
    .from("tds_challans")
    .insert({
      challan_ref: challanRef,
      bsr_code: d.bsr_code,
      challan_serial: d.challan_serial,
      deposit_date: d.deposit_date,
      period_month: d.period_month,
      period_year: d.period_year,
      section_code: d.section_code,
      total_amount: d.total_amount,
      receipt_url: d.receipt_url ?? null,
      notes: d.notes ?? null,
      deposited_by: dbUser.id,
    })
    .select("id, challan_ref")
    .single();

  if (challanError || !challan) {
    return NextResponse.json({ error: challanError?.message ?? "Failed to create challan" }, { status: 500 });
  }

  // Mark all linked TDS entries as deposited
  const { error: updateError } = await supabase
    .from("vendor_bill_tds")
    .update({ status: "deposited", challan_id: challan.id })
    .in("id", d.tds_entry_ids);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ data: challan });
}
