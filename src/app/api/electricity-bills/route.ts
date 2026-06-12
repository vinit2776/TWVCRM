import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { computeElectricityBill } from "@/lib/electricity";
import { createVendorBill } from "@/lib/vendor-bills";

const lineSchema = z.object({
  line_type: z.enum(["utility", "generator", "other"]),
  meter_label: z.string().nullish(),
  label: z.string().nullish(),
  units: z.number().min(0).nullish(),
  rate: z.number().min(0).nullish(),
  // 'other' lines carry a fixed amount instead of units×rate
  amount: z.number().min(0).nullish(),
  sort_order: z.number().int().default(0),
}).refine(
  (l) => {
    if (l.line_type === "other") return (l.amount ?? 0) > 0;
    return (l.units ?? 0) > 0 && (l.rate ?? 0) > 0;
  },
  { message: "utility/generator lines require units + rate; other lines require amount" },
);

const createSchema = z.object({
  location_id: z.string().uuid(),
  bill_month: z.number().int().min(1).max(12),
  bill_year: z.number().int().min(2020),
  landlord_bill_number: z.string().nullish(),
  landlord_bill_date: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(lineSchema).min(1, "At least one line is required"),
});

export async function GET(request: NextRequest) {
  const supabase = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const month = searchParams.get("month");
  const year = searchParams.get("year");
  const status = searchParams.get("status");

  let query = supabase
    .from("electricity_bills")
    .select(`
      *,
      electricity_bill_lines(*),
      locations(id, name, code),
      created_by_user:users!electricity_bills_created_by_fkey(id, full_name),
      confirmed_by_user:users!electricity_bills_confirmed_by_fkey(id, full_name)
    `)
    .order("created_at", { ascending: false });

  if (locationId) query = query.eq("location_id", locationId);
  if (month) query = query.eq("bill_month", parseInt(month));
  if (year) query = query.eq("bill_year", parseInt(year));
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { location_id, bill_month, bill_year, landlord_bill_number, landlord_bill_date, notes, lines } = parsed.data;

  // ── Fetch config ──────────────────────────────────────────────────────────
  const { data: config } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", location_id)
    .maybeSingle();

  if (!config) {
    return NextResponse.json({ error: "Electricity config not found for this location. Configure it first under Location → Electricity tab." }, { status: 422 });
  }
  if (!config.enabled) {
    return NextResponse.json({ error: "Electricity billing is not enabled for this location." }, { status: 422 });
  }

  // ── Idempotency: block duplicate active bill ──────────────────────────────
  const { count: existing } = await supabase
    .from("electricity_bills")
    .select("*", { count: "exact", head: true })
    .eq("location_id", location_id)
    .eq("bill_month", bill_month)
    .eq("bill_year", bill_year)
    .neq("status", "revised");

  if (existing && existing > 0) {
    return NextResponse.json(
      { error: `An active electricity bill already exists for ${bill_month}/${bill_year}. Revise the existing bill instead.` },
      { status: 409 },
    );
  }

  // ── Compute ───────────────────────────────────────────────────────────────
  const computeLines = lines
    .filter((l) => l.line_type !== "other")
    .map((l) => ({
      line_type: l.line_type as "utility" | "generator",
      units: l.units ?? 0,
      landlord_rate: l.rate ?? 0,
    }));

  const computeConfig = {
    reimbursement_enabled: config.reimbursement_enabled as boolean,
    customer_markup_type: config.markup_type as "per_unit" | "percent",
    customer_markup_per_unit: config.markup_type === "per_unit" ? Number(config.markup_value) : 0,
    customer_markup_percent: config.markup_type === "percent" ? Number(config.markup_value) : 0,
    landlord_gst_rate: config.landlord_gst_applicable ? Number(config.landlord_gst_rate ?? 0) : 0,
    landlord_tds_rate: Number(config.tds_rate ?? 0),
  };

  // 'other' lines are fixed-amount: add them directly to landlord_total
  const otherLinesTotal = lines
    .filter((l) => l.line_type === "other")
    .reduce((s, l) => s + (l.amount ?? 0), 0);

  const result = computeElectricityBill(computeConfig, computeLines);

  const landlordTotal = result.landlord_subtotal + otherLinesTotal;

  // ── Insert electricity_bills ──────────────────────────────────────────────
  const { data: bill, error: billError } = await supabase
    .from("electricity_bills")
    .insert({
      location_id,
      bill_month,
      bill_year,
      landlord_bill_number: landlord_bill_number ?? null,
      landlord_bill_date: landlord_bill_date ?? null,
      landlord_total_amount: landlordTotal,
      reimbursement_enabled: config.reimbursement_enabled,
      landlord_utility_pct: config.landlord_utility_pct,
      landlord_generator_pct: config.landlord_generator_pct,
      customer_utility_pct: config.customer_utility_pct,
      customer_generator_pct: config.customer_generator_pct,
      customer_markup_type: config.markup_type,
      customer_markup_value: config.markup_value,
      customer_subtotal: config.reimbursement_enabled ? result.customer_subtotal : null,
      customer_cgst: config.reimbursement_enabled ? result.customer_gst.cgst : null,
      customer_sgst: config.reimbursement_enabled ? result.customer_gst.sgst : null,
      customer_total: config.reimbursement_enabled ? result.customer_total : null,
      customer_round_off: config.reimbursement_enabled ? result.customer_gst.roundOff : null,
      gst_rate: 18,
      status: "draft",
      created_by: dbUser.id,
    })
    .select("id")
    .single();

  if (billError) return NextResponse.json({ error: billError.message }, { status: 500 });

  // ── Insert lines ──────────────────────────────────────────────────────────
  const lineInserts = lines.map((l, i) => {
    const computed = result.lines.find((cl) => cl.line_type === l.line_type);
    return {
      electricity_bill_id: bill.id,
      line_type: l.line_type,
      meter_label: l.meter_label ?? null,
      label: l.label ?? null,
      units: l.line_type !== "other" ? (l.units ?? null) : null,
      rate: l.line_type !== "other" ? (l.rate ?? null) : null,
      amount: l.line_type === "other" ? (l.amount ?? 0) : (computed?.landlord_amount ?? 0),
      sort_order: l.sort_order ?? i,
    };
  });

  const { error: linesError } = await supabase
    .from("electricity_bill_lines")
    .insert(lineInserts);

  if (linesError) {
    // Roll back the bill header on lines failure
    await supabase.from("electricity_bills").delete().eq("id", bill.id);
    return NextResponse.json({ error: linesError.message }, { status: 500 });
  }

  // ── Auto-create landlord vendor bill ──────────────────────────────────────
  let vendorBillId: string | null = null;
  if (config.landlord_vendor_id) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const dueDay = config.bill_due_day_of_month ?? 15;
      const dueDate = new Date(bill_year, bill_month - 1, dueDay).toISOString().split("T")[0];

      const vb = await createVendorBill(supabase, {
        vendor_id: config.landlord_vendor_id,
        invoice_number: landlord_bill_number ?? null,
        invoice_date: landlord_bill_date ?? today,
        due_date: dueDate,
        total_amount: landlordTotal,
        gst_amount: result.landlord_gst,
        notes: notes ?? null,
        electricity_bill_id: bill.id,
        created_by: dbUser.id,
      });
      vendorBillId = vb.id;

      await supabase
        .from("electricity_bills")
        .update({ vendor_bill_id: vendorBillId })
        .eq("id", bill.id);
    } catch (e) {
      // Non-fatal: bill is captured; vendor bill can be created manually
      console.error("[eb] vendor bill auto-create failed:", e);
    }
  }

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: bill.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      location_id: { old: null, new: location_id },
      bill_month: { old: null, new: bill_month },
      bill_year: { old: null, new: bill_year },
      landlord_total: { old: null, new: landlordTotal },
      customer_total: { old: null, new: config.reimbursement_enabled ? result.customer_total : null },
      vendor_bill_id: { old: null, new: vendorBillId },
    },
  });

  return NextResponse.json({ data: { id: bill.id, vendor_bill_id: vendorBillId } }, { status: 201 });
}
