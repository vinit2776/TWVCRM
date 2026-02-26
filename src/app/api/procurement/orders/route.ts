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
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair"]),
  unit_price: z.number().min(0).nullish(),
  notes: z.string().nullish(),
});

const createPoSchema = z.object({
  pr_id: z.string().uuid("A linked Purchase Request is required"),
  vendor_id: z.string().uuid(),
  location_id: z.string().uuid().nullish(),
  expected_delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
  payment_terms: z.string().nullish(),
  terms_and_conditions: z.string().nullish(),
  items: z.array(createPoItemSchema).min(1, "At least one item is required"),
});

function generatePoNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `PO-${yy}${mm}-${seq}`;
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
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  let query = supabase
    .from("purchase_orders")
    .select(
      `*, procurement_vendors(id, name), locations(id, name), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), purchase_requests(id, pr_number, department)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  if (locationId) query = query.eq("location_id", locationId);
  if (prId) query = query.eq("pr_id", prId);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only managers and admins can create purchase orders" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createPoSchema.safeParse(body);
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
  // Use computeOrderedQtyMap so cancelled POs don't count against remaining qty
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

  const { count: existingCount } = await supabase
    .from("purchase_orders")
    .select("*", { count: "exact", head: true });

  const poNumber = generatePoNumber(existingCount ?? 0);

  // ── 4. Insert purchase order ──
  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .insert({
      ...poData,
      pr_id: poData.pr_id,
      location_id: poData.location_id ?? null,
      expected_delivery_date: poData.expected_delivery_date ?? null,
      notes: poData.notes ?? null,
      payment_terms: poData.payment_terms ?? null,
      terms_and_conditions: poData.terms_and_conditions ?? null,
      po_number: poNumber,
      ordered_by: dbUser.id,
      total_ordered_amount: totalOrderedAmount,
      status: "pending",
    })
    .select("id, po_number")
    .single();

  if (poError) return NextResponse.json({ error: poError.message }, { status: 500 });

  // ── 5. Batch insert line items ──
  const lineItems = items.map((item) => ({
    po_id: po.id,
    pr_item_id: item.pr_item_id ?? null,
    item_id: item.item_id ?? null,
    item_name: item.item_name,
    quantity_ordered: item.quantity_ordered,
    quantity_received: 0,
    unit: item.unit,
    unit_price: item.unit_price ?? null,
    total_amount: item.unit_price ? item.quantity_ordered * item.unit_price : null,
    notes: item.notes ?? null,
  }));

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
