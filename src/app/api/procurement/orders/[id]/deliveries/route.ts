import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createDeliverySchema = z.object({
  dc_number: z.string().nullish(),
  dc_date: z.string().min(1, "Delivery date is required"),
  file_url: z.string().url("Delivery challan file URL is required"),
  notes: z.string().nullish(),
  items: z
    .array(
      z.object({
        po_item_id: z.string().uuid(),
        qty_received: z.number().min(0),
      })
    )
    .min(1, "At least one item is required"),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("po_delivery_receipts")
    .select(
      `*, receiver:users!po_delivery_receipts_received_by_fkey(id, full_name, email), po_delivery_receipt_items(id, po_item_id, qty_received)`
    )
    .eq("po_id", id)
    .order("received_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only floor managers, managers, and admins can record deliveries" },
      { status: 403 }
    );
  }

  // Validate PO exists and is in a receivable state
  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, status, vendor_id")
    .eq("id", id)
    .single();

  if (poErr || !po)
    return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  if (!["ordered", "partially_received"].includes(po.status)) {
    return NextResponse.json(
      { error: "Only ordered or partially received POs can record a delivery" },
      { status: 422 }
    );
  }

  const body = await request.json();
  const parsed = createDeliverySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { dc_number, dc_date, file_url, notes, items } = parsed.data;

  // Validate at least one item has qty > 0
  if (items.every((i) => i.qty_received === 0)) {
    return NextResponse.json(
      { error: "At least one item must have a quantity received greater than 0" },
      { status: 422 }
    );
  }

  // Fetch all PO items to validate ownership and over-receiving
  const { data: poItems } = await supabase
    .from("purchase_order_items")
    .select("id, quantity_ordered, quantity_received")
    .eq("po_id", id);

  const poItemMap = Object.fromEntries(
    (poItems ?? []).map((i) => [i.id, i])
  );

  for (const item of items) {
    const poItem = poItemMap[item.po_item_id];
    if (!poItem) {
      return NextResponse.json(
        { error: `Item ${item.po_item_id} does not belong to this purchase order` },
        { status: 422 }
      );
    }
    const remaining =
      Number(poItem.quantity_ordered) - Number(poItem.quantity_received);
    if (item.qty_received > remaining) {
      return NextResponse.json(
        {
          error: `Quantity received (${item.qty_received}) exceeds remaining quantity (${remaining}) for item ${item.po_item_id}`,
        },
        { status: 422 }
      );
    }
  }

  // Insert delivery receipt header
  const { data: receipt, error: receiptErr } = await supabase
    .from("po_delivery_receipts")
    .insert({
      po_id: id,
      dc_number: dc_number ?? null,
      dc_date,
      file_url,
      notes: notes ?? null,
      received_by: dbUser.id,
    })
    .select("id, received_at")
    .single();

  if (receiptErr || !receipt) {
    return NextResponse.json(
      { error: receiptErr?.message ?? "Failed to create delivery receipt" },
      { status: 500 }
    );
  }

  // Insert per-item records (only items with qty > 0)
  const itemRows = items
    .filter((i) => i.qty_received > 0)
    .map((i) => ({
      delivery_receipt_id: receipt.id,
      po_item_id: i.po_item_id,
      qty_received: i.qty_received,
    }));

  if (itemRows.length > 0) {
    const { error: itemsErr } = await supabase
      .from("po_delivery_receipt_items")
      .insert(itemRows);
    if (itemsErr) {
      return NextResponse.json({ error: itemsErr.message }, { status: 500 });
    }
  }

  // Increment quantity_received on each purchase_order_item
  for (const item of items.filter((i) => i.qty_received > 0)) {
    await supabase
      .from("purchase_order_items")
      .update({
        quantity_received: Number(poItemMap[item.po_item_id].quantity_received) + item.qty_received,
      })
      .eq("id", item.po_item_id)
      .eq("po_id", id);
  }

  // Re-fetch updated items to determine new PO status
  const { data: updatedItems } = await supabase
    .from("purchase_order_items")
    .select("quantity_ordered, quantity_received")
    .eq("po_id", id);

  const allReceived = (updatedItems ?? []).every(
    (i) => Number(i.quantity_received) >= Number(i.quantity_ordered)
  );

  const newStatus = allReceived ? "received" : "partially_received";
  const updatePayload: Record<string, unknown> = { status: newStatus };
  if (allReceived) {
    updatePayload.actual_delivery_date = dc_date;
  }

  await supabase
    .from("purchase_orders")
    .update(updatePayload)
    .eq("id", id);

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: po.status, new: newStatus },
      delivery_receipt_id: { old: null, new: receipt.id },
    },
  });

  return NextResponse.json({ data: { id: receipt.id, received_at: receipt.received_at } }, { status: 201 });
}
