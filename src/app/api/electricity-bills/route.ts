import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
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
  // Per-bill override — some landlords charge GST, some don't, and it can
  // change month to month, so this isn't fixed at the location config level.
  landlord_gst_applicable: z.boolean().default(false),
  landlord_gst_rate: z.number().min(0).nullish(),
});

export async function GET(request: NextRequest) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const contractId = searchParams.get("contract_id");
  const billSide = searchParams.get("bill_side");
  const month = searchParams.get("month");
  const year = searchParams.get("year");
  const status = searchParams.get("status");

  let query = supabase
    .from("electricity_bills")
    .select(`
      *,
      electricity_bill_lines(*),
      locations(id, name, code),
      contracts(id, contract_number, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)),
      created_by_user:users!electricity_bills_created_by_fkey(id, full_name),
      confirmed_by_user:users!electricity_bills_confirmed_by_fkey(id, full_name)
    `)
    .order("created_at", { ascending: false });

  if (locationId) query = query.eq("location_id", locationId);
  if (contractId) query = query.eq("contract_id", contractId);
  if (billSide) query = query.eq("bill_side", billSide);
  if (month) query = query.eq("bill_month", parseInt(month));
  if (year) query = query.eq("bill_year", parseInt(year));
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Reconciliation enrichment: for landlord bills, attach the linked vendor bill
  // (inward payable) and any generated customer bills + their billing statements
  // (outward receivable) so the UI can show both legs of the same transaction together.
  if (billSide === "landlord" && data && data.length > 0) {
    const landlordIds = data.map((b) => b.id);
    const vendorBillIds = data.map((b) => b.vendor_bill_id).filter((id): id is string => !!id);

    const [vendorBillsRes, customerBillsRes] = await Promise.all([
      vendorBillIds.length > 0
        ? supabase
            .from("vendor_bills")
            .select("id, invoice_number, total_amount, amount_paid, payment_status, approval_status, due_date, vendor:procurement_vendors(id, name)")
            .in("id", vendorBillIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      supabase
        .from("electricity_bills")
        .select(`
          id, landlord_bill_id, contract_id, status, customer_total, billing_statement_id, created_by,
          customer_units_billed, customer_utility_pct, customer_generator_pct,
          customer_utility_rate, customer_generator_rate,
          customer_subtotal, customer_cgst, customer_sgst, customer_round_off, gst_rate,
          contract:contracts(id, contract_number, billing_mode, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)),
          billing_statement:billing_statements(id, statement_number, status, payment_status, total_amount, handoff_state)
        `)
        .in("landlord_bill_id", landlordIds)
        .eq("bill_side", "customer"),
    ]);

    const vendorBillMap = new Map((vendorBillsRes.data ?? []).map((v) => [(v as { id: string }).id, v]));
    const customerBillsByLandlord = new Map<string, Record<string, unknown>[]>();
    for (const cb of (customerBillsRes.data ?? []) as Record<string, unknown>[]) {
      const key = cb.landlord_bill_id as string;
      const arr = customerBillsByLandlord.get(key) ?? [];
      arr.push(cb);
      customerBillsByLandlord.set(key, arr);
    }

    for (const bill of data as Record<string, unknown>[]) {
      bill.vendor_bill = bill.vendor_bill_id ? vendorBillMap.get(bill.vendor_bill_id as string) ?? null : null;
      bill.customer_bills = customerBillsByLandlord.get(bill.id as string) ?? [];
    }
  }

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const {
    location_id, bill_month, bill_year, landlord_bill_number, landlord_bill_date, notes, lines,
    landlord_gst_applicable, landlord_gst_rate,
  } = parsed.data;

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

  // ── Idempotency: block duplicate active landlord bill ─────────────────────
  const { count: existing } = await supabase
    .from("electricity_bills")
    .select("*", { count: "exact", head: true })
    .eq("location_id", location_id)
    .eq("bill_side", "landlord")
    .eq("bill_month", bill_month)
    .eq("bill_year", bill_year)
    .neq("status", "revised");

  if (existing && existing > 0) {
    return NextResponse.json(
      { error: `An active electricity bill already exists for ${bill_month}/${bill_year}. Revise the existing bill instead.` },
      { status: 409 },
    );
  }

  // ── Idempotency: block duplicate landlord bill number at this location ────
  // Real-world trigger: the same physical bill captured twice under different
  // months by mistake, spawning a duplicate vendor bill + customer bill.
  if (landlord_bill_number) {
    const { count: dupeNumber } = await supabase
      .from("electricity_bills")
      .select("*", { count: "exact", head: true })
      .eq("location_id", location_id)
      .eq("bill_side", "landlord")
      .eq("landlord_bill_number", landlord_bill_number)
      .neq("status", "revised");

    if (dupeNumber && dupeNumber > 0) {
      return NextResponse.json(
        { error: `Bill number "${landlord_bill_number}" is already in use for this location. Check for a duplicate entry.` },
        { status: 409 },
      );
    }
  }

  // ── Compute landlord total from bill lines ────────────────────────────────
  const landlordTotal = lines.reduce((s, l) => {
    if (l.line_type === "other") return s + (l.amount ?? 0);
    return s + (l.units ?? 0) * (l.rate ?? 0);
  }, 0);

  // Per-bill GST override — some landlords charge GST, some don't, and it can
  // vary month to month, so this is captured on the bill, not just the
  // location's one-time default.
  const landlordGstAmount = landlord_gst_applicable
    ? Math.round(landlordTotal * (Number(landlord_gst_rate ?? 0) / 100) * 100) / 100
    : 0;

  // ── Insert electricity_bills (landlord side) ──────────────────────────────
  const { data: bill, error: billError } = await supabase
    .from("electricity_bills")
    .insert({
      location_id,
      bill_side: "landlord",
      bill_month,
      bill_year,
      landlord_bill_number: landlord_bill_number ?? null,
      landlord_bill_date: landlord_bill_date ?? null,
      landlord_total_amount: landlordTotal,
      landlord_gst_applicable,
      landlord_gst_rate: landlord_gst_applicable ? (landlord_gst_rate ?? 18) : null,
      landlord_gst_amount: landlordGstAmount,
      reimbursement_enabled: config.reimbursement_enabled,
      landlord_utility_pct: config.landlord_utility_pct,
      landlord_generator_pct: config.landlord_generator_pct,
      gst_rate: 18,
      status: "draft",
      created_by: dbUser.id,
    })
    .select("id")
    .single();

  if (billError) return NextResponse.json({ error: billError.message }, { status: 500 });

  // ── Insert lines ──────────────────────────────────────────────────────────
  const lineInserts = lines.map((l, i) => ({
    electricity_bill_id: bill.id,
    line_type: l.line_type,
    meter_label: l.meter_label ?? null,
    label: l.label ?? null,
    units: l.line_type !== "other" ? (l.units ?? null) : null,
    rate: l.line_type !== "other" ? (l.rate ?? null) : null,
    amount: l.line_type === "other" ? (l.amount ?? 0) : (l.units ?? 0) * (l.rate ?? 0),
    sort_order: l.sort_order ?? i,
  }));

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
        gst_amount: landlordGstAmount,
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
      vendor_bill_id: { old: null, new: vendorBillId },
    },
  });

  return NextResponse.json({ data: { id: bill.id, vendor_bill_id: vendorBillId } }, { status: 201 });
}
