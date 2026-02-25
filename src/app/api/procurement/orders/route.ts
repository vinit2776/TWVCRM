import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

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
  pr_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid(),
  location_id: z.string().uuid().nullish(),
  expected_delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
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

  // Compute total ordered amount
  const totalOrderedAmount = items.reduce((sum, item) => {
    return sum + item.quantity_ordered * (item.unit_price ?? 0);
  }, 0);

  // Generate PO number
  const { count: existingCount } = await supabase
    .from("purchase_orders")
    .select("*", { count: "exact", head: true });

  const poNumber = generatePoNumber(existingCount ?? 0);

  // Insert purchase order
  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .insert({
      ...poData,
      pr_id: poData.pr_id ?? null,
      location_id: poData.location_id ?? null,
      expected_delivery_date: poData.expected_delivery_date ?? null,
      notes: poData.notes ?? null,
      po_number: poNumber,
      ordered_by: dbUser.id,
      total_ordered_amount: totalOrderedAmount,
      status: "pending",
    })
    .select("id, po_number")
    .single();

  if (poError) return NextResponse.json({ error: poError.message }, { status: 500 });

  // Batch insert purchase order items
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

  // If pr_id provided, atomically update PR status to po_created (guarded by status check)
  if (poData.pr_id) {
    await supabase
      .from("purchase_requests")
      .update({ status: "po_created" })
      .eq("id", poData.pr_id)
      .eq("status", "approved");
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: po.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: { id: po.id, po_number: po.po_number } }, { status: 201 });
}
