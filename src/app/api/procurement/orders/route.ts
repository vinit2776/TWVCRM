import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { computeOrderedQtyMap, recalculatePrStatus } from "@/lib/procurement/pr-status";

const createPoItemSchema = z.object({
  pr_item_id: z.string().uuid().nullish(),
  item_id: z.string().uuid().nullish(),
  item_name: z.string().min(1),
  quantity_ordered: z.number().positive(),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year", "nos", "can", "ton"]),
  unit_price: z.number().min(0).nullish(),
  gst_rate: z.number().min(0).max(28).default(0),
  notes: z.string().nullish(),
});

const advancePaymentSchema = z.object({
  advance_amount: z.number().positive("Advance amount must be greater than 0").nullish(),
  advance_payment_mode: z.enum(["cash", "upi", "bank_transfer"]).nullish(),
  advance_payment_reference: z.string().nullish(),
  advance_notes: z.string().nullish(),
});

const createGoodsPoSchema = z.object({
  po_type: z.literal("goods").optional().default("goods"),
  pr_id: z.string().uuid("A linked Purchase Request is required"),
  vendor_id: z.string().uuid(),
  location_id: z.string().uuid().nullish(),
  expected_delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
  payment_terms: z.string().nullish(),
  terms_and_conditions: z.string().nullish(),
  items: z.array(createPoItemSchema).min(1, "At least one item is required"),
}).merge(advancePaymentSchema).refine(
  (d) => {
    if (!d.expected_delivery_date) return true; // field is optional
    const today = new Date().toISOString().split("T")[0];
    return d.expected_delivery_date >= today;
  },
  {
    message: "Expected delivery date cannot be in the past. Only today or a future date is allowed.",
    path: ["expected_delivery_date"],
  },
);

const createServicePoSchema = z.object({
  po_type: z.literal("service"),
  vendor_id: z.string().uuid(),
  location_id: z.string().uuid().nullish(),
  service_start_date: z.string().min(1, "Service start date is required"),
  billing_cycle: z.enum(["monthly", "quarterly", "yearly"]),
  cycle_count: z.number().int().positive("Number of cycles must be at least 1"),
  unit_cost_per_cycle: z.number().positive("Cost per cycle must be greater than 0"),
  service_item_name: z.string().min(1, "Service description is required"),
  item_id: z.string().uuid().nullish(),
  gst_rate: z.number().min(0).max(28).default(0),
  notes: z.string().nullish(),
  payment_terms: z.string().nullish(),
  terms_and_conditions: z.string().nullish(),
  // AMC fields (optional — for AMC contracts)
  amc_start_date: z.string().nullish(),
  amc_end_date: z.string().nullish(),
  amc_visits_covered: z.number().int().positive().nullish(),
  amc_contact_name: z.string().nullish(),
  amc_helpline_number: z.string().nullish(),
  amc_contact_email: z.string().email().nullish().or(z.literal("").transform(() => null)),
}).merge(advancePaymentSchema);

function generatePoNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `PO-${yy}${mm}-${seq}`;
}

// Helper: apply shared filters to any purchase_orders query
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPoFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  opts: {
    status?: string | null;
    vendorId?: string | null;
    locationId?: string | null;
    prId?: string | null;
    advanceStatus?: string | null;
    search?: string;
    prIdsFromDept?: string[] | null;
    monthStart?: string | null;
    monthEnd?: string | null;
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { status, vendorId, locationId, prId, advanceStatus, search, prIdsFromDept, monthStart, monthEnd } = opts;
  if (status) query = query.eq("status", status);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  if (locationId) query = query.eq("location_id", locationId);
  if (prId) query = query.eq("pr_id", prId);
  if (advanceStatus) query = query.eq("advance_status", advanceStatus);
  // Department filter: pre-resolved to a list of PR IDs
  if (prIdsFromDept) {
    if (prIdsFromDept.length === 0) {
      // No PRs found for this dept — force no results
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("pr_id", prIdsFromDept);
    }
  }
  if (monthStart) query = query.gte("created_at", monthStart);
  if (monthEnd) query = query.lt("created_at", monthEnd);
  if (search && search.length >= 3) {
    // vendorIds are resolved before calling this helper
  }
  return query;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const vendorId = searchParams.get("vendor_id");
  const locationId = searchParams.get("location_id");
  const prId = searchParams.get("pr_id");
  const advanceStatus = searchParams.get("advance_status");
  const department = searchParams.get("department");
  const month = searchParams.get("month"); // YYYY-MM
  const includeTotals = searchParams.get("include_totals") === "true";
  const search = searchParams.get("search")?.trim() ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  // ── Resolve department → PR IDs (goods POs only; service POs have no PR) ──
  let prIdsFromDept: string[] | null = null;
  if (department) {
    const { data: matchingPrs } = await supabase
      .from("purchase_requests")
      .select("id")
      .eq("department", department);
    prIdsFromDept = (matchingPrs ?? []).map((r: { id: string }) => r.id);
  }

  // ── Resolve month → UTC date range ─────────────────────────────────────────
  let monthStart: string | null = null;
  let monthEnd: string | null = null;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [yr, mo] = month.split("-").map(Number);
    monthStart = `${month}-01T00:00:00.000Z`;
    const nextMo = mo === 12 ? 1 : mo + 1;
    const nextYr = mo === 12 ? yr + 1 : yr;
    monthEnd = `${String(nextYr).padStart(4, "0")}-${String(nextMo).padStart(2, "0")}-01T00:00:00.000Z`;
  }

  // ── Resolve search → vendor IDs ────────────────────────────────────────────
  let vendorIdsFromSearch: string[] | null = null;
  if (search.length >= 3) {
    const { data: matchingVendors } = await supabase
      .from("procurement_vendors")
      .select("id")
      .ilike("name", `%${search}%`);
    vendorIdsFromSearch = (matchingVendors ?? []).map((v: { id: string }) => v.id);
  }

  const filterOpts = { status, vendorId, locationId, prId, advanceStatus, prIdsFromDept, monthStart, monthEnd };

  // ── Main paginated query ────────────────────────────────────────────────────
  let query = supabase
    .from("purchase_orders")
    .select(
      `*, procurement_vendors(id, name), locations(id, name), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), purchase_requests(id, pr_number, department)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  query = applyPoFilters(query, filterOpts);

  // Apply search (vendor IDs already resolved above)
  if (search.length >= 3) {
    if (vendorIdsFromSearch && vendorIdsFromSearch.length > 0) {
      query = query.or(`po_number.ilike.%${search}%,vendor_id.in.(${vendorIdsFromSearch.join(",")})`);
    } else {
      query = query.ilike("po_number", `%${search}%`);
    }
  }

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ── Totals query (all matching rows, no pagination) ─────────────────────────
  let totals: {
    totalExGst: number;
    totalInclGst: number;
    poCount: number;
    budget: number | null;
    budgetBalance: number | null;
  } | null = null;

  if (includeTotals) {
    let totalsQuery = supabase
      .from("purchase_orders")
      .select("total_ordered_amount, total_amount_with_gst");

    totalsQuery = applyPoFilters(totalsQuery, filterOpts);

    if (search.length >= 3) {
      if (vendorIdsFromSearch && vendorIdsFromSearch.length > 0) {
        totalsQuery = totalsQuery.or(`po_number.ilike.%${search}%,vendor_id.in.(${vendorIdsFromSearch.join(",")})`);
      } else {
        totalsQuery = totalsQuery.ilike("po_number", `%${search}%`);
      }
    }

    // Run PO totals + optional budget fetch in parallel
    const [{ data: allPos }, budgetRow] = await Promise.all([
      totalsQuery,
      // Only fetch budget when department + month are both selected
      (department && month)
        ? supabase
            .from("department_budgets")
            .select("monthly_budget, is_active")
            .eq("department", department)
            .is("location_id", null)
            .single()
        : Promise.resolve({ data: null }),
    ]);

    const totalExGst = allPos?.reduce((s, p) => s + Number(p.total_ordered_amount ?? 0), 0) ?? 0;
    const totalInclGst = allPos?.reduce((s, p) => s + Number(p.total_amount_with_gst ?? 0), 0) ?? 0;
    const budget = budgetRow.data?.monthly_budget != null
      ? Number(budgetRow.data.monthly_budget)
      : null;

    totals = {
      totalExGst,
      totalInclGst,
      poCount: allPos?.length ?? 0,
      budget,
      budgetBalance: budget !== null ? budget - totalExGst : null,
    };
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
    totals,
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();

  // ── Route to goods or service PO handler ──────────────────────────────────
  const poType = body?.po_type ?? "goods";

  if (poType === "service") {
    // ── SERVICE PO ────────────────────────────────────────────────────────────
    const parsed = createServicePoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { count: existingCount } = await supabase
      .from("purchase_orders")
      .select("*", { count: "exact", head: true });
    const poNumber = generatePoNumber(existingCount ?? 0);

    const totalAmount = parsed.data.unit_cost_per_cycle * parsed.data.cycle_count;
    const svcGstRate = parsed.data.gst_rate ?? 0;
    const svcGstAmount = Math.round(totalAmount * svcGstRate) / 100;
    const totalWithGst = totalAmount + svcGstAmount;

    // Advance cannot exceed PO total (including GST)
    if (parsed.data.advance_amount && parsed.data.advance_amount > totalWithGst) {
      return NextResponse.json({
        error: `Advance amount (₹${parsed.data.advance_amount.toLocaleString("en-IN")}) cannot exceed PO total (₹${totalWithGst.toLocaleString("en-IN")})`
      }, { status: 422 });
    }

    const hasAdvance = !!parsed.data.advance_amount;
    // Compute initial amc_status if AMC dates were provided
    const amcStart = parsed.data.amc_start_date ?? null;
    const amcEnd = parsed.data.amc_end_date ?? null;
    const amcVisitsCovered = parsed.data.amc_visits_covered ?? null;
    let amcStatus = "inactive";
    if (amcStart) {
      const today = new Date();
      const start = new Date(amcStart);
      if (today >= start) {
        if (amcEnd && today > new Date(amcEnd)) {
          amcStatus = "expired";
        } else if (amcEnd) {
          const daysLeft = Math.floor((new Date(amcEnd).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          amcStatus = daysLeft <= 60 ? "expiring" : "active";
        } else {
          amcStatus = "active";
        }
      }
    }

    const { data: po, error: poError } = await supabase
      .from("purchase_orders")
      .insert({
        po_type: "service",
        vendor_id: parsed.data.vendor_id,
        location_id: parsed.data.location_id ?? null,
        service_start_date: parsed.data.service_start_date,
        billing_cycle: parsed.data.billing_cycle,
        cycle_count: parsed.data.cycle_count,
        unit_cost_per_cycle: parsed.data.unit_cost_per_cycle,
        notes: parsed.data.notes ?? null,
        payment_terms: parsed.data.payment_terms ?? null,
        terms_and_conditions: parsed.data.terms_and_conditions ?? null,
        po_number: poNumber,
        ordered_by: dbUser.id,
        total_ordered_amount: totalAmount,
        total_gst_amount: svcGstAmount,
        total_amount_with_gst: totalAmount + svcGstAmount,
        status: "pending",
        advance_amount: parsed.data.advance_amount ?? null,
        advance_payment_mode: parsed.data.advance_payment_mode ?? null,
        advance_payment_reference: parsed.data.advance_payment_reference ?? null,
        advance_notes: parsed.data.advance_notes ?? null,
        // AMC fields
        amc_start_date: amcStart,
        amc_end_date: amcEnd,
        amc_visits_covered: amcVisitsCovered,
        amc_visits_used: 0,
        amc_contact_name: parsed.data.amc_contact_name ?? null,
        amc_helpline_number: parsed.data.amc_helpline_number ?? null,
        amc_contact_email: parsed.data.amc_contact_email ?? null,
        amc_status: amcStatus,
        advance_status: hasAdvance ? "pending" : "not_required",
      })
      .select("id, po_number")
      .single();

    if (poError) return NextResponse.json({ error: poError.message }, { status: 500 });

    // Insert a single representative line item for the service
    const unitMap: Record<string, string> = { monthly: "month", quarterly: "quarter", yearly: "year" };
    await supabase.from("purchase_order_items").insert({
      po_id: po.id,
      item_id: parsed.data.item_id ?? null,
      item_name: parsed.data.service_item_name,
      quantity_ordered: parsed.data.cycle_count,
      quantity_received: 0,
      unit: unitMap[parsed.data.billing_cycle],
      unit_price: parsed.data.unit_cost_per_cycle,
      total_amount: totalAmount,
      gst_rate: svcGstRate,
      gst_amount: svcGstAmount,
    });

    await logAudit(supabase, {
      entityType: "purchase_order",
      entityId: po.id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        po_number: { old: null, new: po.po_number },
        po_type: { old: null, new: "service" },
        vendor_id: { old: null, new: parsed.data.vendor_id },
        total_ordered_amount: { old: null, new: totalAmount },
        billing_cycle: { old: null, new: parsed.data.billing_cycle },
        cycle_count: { old: null, new: parsed.data.cycle_count },
      },
    });

    return NextResponse.json({ data: { id: po.id, po_number: po.po_number } }, { status: 201 });
  }

  // ── GOODS PO ───────────────────────────────────────────────────────────────
  const parsed = createGoodsPoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { items, ...poData } = parsed.data;

  // ── 1. Validate PR exists and is in an approvable state ──
  const { data: pr, error: prFetchError } = await supabase
    .from("purchase_requests")
    .select("id, status, purchase_request_items(id, quantity, estimated_price)")
    .eq("id", parsed.data.pr_id)
    .single();

  if (prFetchError || !pr) {
    return NextResponse.json({ error: "Purchase request not found" }, { status: 404 });
  }
  if (!["approved", "partially_ordered"].includes(pr.status)) {
    return NextResponse.json({
      error: "A Purchase Order can only be created from an approved or partially ordered Purchase Request"
    }, { status: 422 });
  }

  // ── 2. Validate item qty / price ceilings ──
  const prItemIds = items.filter(i => i.pr_item_id).map(i => i.pr_item_id!);
  const alreadyOrderedMap: Record<string, number> = {};

  if (prItemIds.length > 0) {
    const existingMap = await computeOrderedQtyMap(supabase, prItemIds);
    for (const [k, v] of Object.entries(existingMap)) {
      alreadyOrderedMap[k] = v;
    }
  }

  const prItemMap = Object.fromEntries(
    ((pr.purchase_request_items ?? []) as Array<{ id: string; quantity: number; estimated_price?: number }>)
      .map(i => [i.id, i])
  );

  for (const item of items) {
    if (!item.pr_item_id) continue;
    const prItem = prItemMap[item.pr_item_id];
    if (!prItem) continue;

    const remaining = Number(prItem.quantity) - (alreadyOrderedMap[item.pr_item_id] ?? 0);

    if (item.quantity_ordered > remaining) {
      return NextResponse.json({
        error: `"${item.item_name}": ordered quantity (${item.quantity_ordered}) exceeds remaining approved quantity (${remaining})`
      }, { status: 422 });
    }

    if (prItem.estimated_price && item.unit_price != null && item.unit_price > Number(prItem.estimated_price)) {
      return NextResponse.json({
        error: `"${item.item_name}": unit price exceeds approved estimated price (Rs. ${prItem.estimated_price})`
      }, { status: 422 });
    }
  }

  // ── 3. Compute total and generate PO number ──
  const totalOrderedAmount = items.reduce((sum, item) => {
    return sum + item.quantity_ordered * (item.unit_price ?? 0);
  }, 0);

  const totalGstAmount = items.reduce((sum, item) => {
    const base = item.quantity_ordered * (item.unit_price ?? 0);
    return sum + Math.round(base * (item.gst_rate ?? 0)) / 100;
  }, 0);

  const { count: existingCount } = await supabase
    .from("purchase_orders")
    .select("*", { count: "exact", head: true });

  const poNumber = generatePoNumber(existingCount ?? 0);

  // ── 4. Validate advance amount ≤ PO total ──
  const goodsTotalWithGst = totalOrderedAmount + totalGstAmount;
  if (parsed.data.advance_amount && parsed.data.advance_amount > goodsTotalWithGst) {
    return NextResponse.json({
      error: `Advance amount (₹${parsed.data.advance_amount.toLocaleString("en-IN")}) cannot exceed PO total (₹${goodsTotalWithGst.toLocaleString("en-IN")})`
    }, { status: 422 });
  }

  // ── 5. Insert purchase order ──
  const hasAdvance = !!parsed.data.advance_amount;
  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .insert({
      po_type: "goods",
      pr_id: poData.pr_id,
      vendor_id: poData.vendor_id,
      location_id: poData.location_id ?? null,
      expected_delivery_date: poData.expected_delivery_date ?? null,
      notes: poData.notes ?? null,
      payment_terms: poData.payment_terms ?? null,
      terms_and_conditions: poData.terms_and_conditions ?? null,
      po_number: poNumber,
      ordered_by: dbUser.id,
      total_ordered_amount: totalOrderedAmount,
      total_gst_amount: totalGstAmount,
      total_amount_with_gst: totalOrderedAmount + totalGstAmount,
      status: "pending",
      advance_amount: parsed.data.advance_amount ?? null,
      advance_payment_mode: parsed.data.advance_payment_mode ?? null,
      advance_payment_reference: parsed.data.advance_payment_reference ?? null,
      advance_notes: parsed.data.advance_notes ?? null,
      advance_status: hasAdvance ? "pending" : "not_required",
    })
    .select("id, po_number")
    .single();

  if (poError) return NextResponse.json({ error: poError.message }, { status: 500 });

  // ── 5. Batch insert line items ──
  const lineItems = items.map((item) => {
    const baseAmount = item.unit_price ? item.quantity_ordered * item.unit_price : 0;
    const gstRate = item.gst_rate ?? 0;
    const gstAmount = Math.round(baseAmount * gstRate) / 100;
    return {
      po_id: po.id,
      pr_item_id: item.pr_item_id ?? null,
      item_id: item.item_id ?? null,
      item_name: item.item_name,
      quantity_ordered: item.quantity_ordered,
      quantity_received: 0,
      unit: item.unit,
      unit_price: item.unit_price ?? null,
      total_amount: item.unit_price ? item.quantity_ordered * item.unit_price : null,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      notes: item.notes ?? null,
    };
  });

  const { error: itemsError } = await supabase.from("purchase_order_items").insert(lineItems);
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  // ── 6. Recalculate PR status (approved / partially_ordered / po_created) ──
  await recalculatePrStatus(supabase, poData.pr_id);

  // ── 7. Audit log ──
  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: po.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      po_number: { old: null, new: po.po_number },
      pr_id: { old: null, new: poData.pr_id },
      vendor_id: { old: null, new: poData.vendor_id },
      total_ordered_amount: { old: null, new: totalOrderedAmount },
      item_count: { old: null, new: items.length },
    },
  });

  return NextResponse.json({ data: { id: po.id, po_number: po.po_number } }, { status: 201 });
}
