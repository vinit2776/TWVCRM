import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { recalculatePrStatus } from "@/lib/procurement/pr-status";
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
}).refine(
  (d) => {
    const today = new Date().toISOString().split("T")[0];
    return d.dc_date >= today;
  },
  {
    message: "Delivery date cannot be in the past. Only today or a future date is allowed.",
    path: ["dc_date"],
  },
);

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

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403 }
    );
  }

  // Validate PO exists and is in a receivable state
  // Also fetch pr_id so we can fall back to the PR's location when the PO has none
  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, status, vendor_id, location_id, pr_id")
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

  // Fetch all PO items — also include pr_item_id so we can resolve item_id
  // via the PR item when the PO item itself has no item_id set.
  const { data: poItems } = await supabase
    .from("purchase_order_items")
    .select("id, item_id, quantity_ordered, quantity_received, pr_item_id, purchase_request_items(id, item_id)")
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

  // ── Update location_stock for each received item ──────────────────────────
  // Resolve the location: use PO's location_id; if absent, fall back to the
  // Purchase Request's location_id (common when location wasn't selected on PO).
  let stockLocationId: string | null = po.location_id ?? null;
  if (!stockLocationId && po.pr_id) {
    const { data: prRow } = await supabase
      .from("purchase_requests")
      .select("location_id")
      .eq("id", po.pr_id)
      .maybeSingle();
    stockLocationId = prRow?.location_id ?? null;
  }

  if (stockLocationId) {
    for (const item of items.filter((i) => i.qty_received > 0)) {
      const poItem = poItemMap[item.po_item_id] as {
        item_id: string | null;
        purchase_request_items?: { item_id: string | null } | null;
        [key: string]: unknown;
      };

      // Prefer item_id on the PO item; fall back to the linked PR item's item_id.
      const resolvedItemId: string | null =
        poItem?.item_id ??
        (poItem?.purchase_request_items as { item_id: string | null } | null)?.item_id ??
        null;

      if (resolvedItemId) {
        const { error: rpcErr } = await supabase.rpc("upsert_location_stock", {
          p_location_id: stockLocationId,
          p_item_id: resolvedItemId,
          p_quantity_delta: item.qty_received,
        });
        if (rpcErr) {
          // Log but don't fail the request — delivery is still recorded
          console.error("[delivery] upsert_location_stock failed:", rpcErr.message, {
            location: stockLocationId,
            item: resolvedItemId,
            qty: item.qty_received,
          });
        }
      }
    }
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: poId } = await params;
  const deliveryId = request.nextUrl.searchParams.get("delivery_id");
  if (!deliveryId) {
    return NextResponse.json({ error: "delivery_id query parameter is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only managers and admins can reject deliveries" }, { status: 403 });
  }

  // Validate PO state
  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, status, pr_id, location_id")
    .eq("id", poId)
    .single();
  if (poErr || !po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  if (!["partially_received", "received"].includes(po.status)) {
    return NextResponse.json({ error: "Deliveries can only be rejected on partially received or received POs" }, { status: 422 });
  }

  // Fetch delivery receipt + items
  const { data: receipt, error: receiptErr } = await supabase
    .from("po_delivery_receipts")
    .select("*, po_delivery_receipt_items(id, po_item_id, qty_received)")
    .eq("id", deliveryId)
    .eq("po_id", poId)
    .single();

  if (receiptErr || !receipt) {
    return NextResponse.json({ error: "Delivery receipt not found" }, { status: 404 });
  }

  // Reverse quantity_received on each PO item + reverse location_stock
  for (const item of receipt.po_delivery_receipt_items ?? []) {
    const { data: poItem } = await supabase
      .from("purchase_order_items")
      .select("item_id, quantity_received")
      .eq("id", item.po_item_id)
      .eq("po_id", poId)
      .single();
    if (poItem) {
      const newQty = Math.max(0, Number(poItem.quantity_received) - Number(item.qty_received));
      await supabase
        .from("purchase_order_items")
        .update({ quantity_received: newQty })
        .eq("id", item.po_item_id)
        .eq("po_id", poId);
      // Reverse location_stock
      if (po.location_id && poItem.item_id) {
        await supabase.rpc("upsert_location_stock", {
          p_location_id: po.location_id,
          p_item_id: poItem.item_id,
          p_quantity_delta: -Number(item.qty_received),
        });
      }
    }
  }

  // Delete receipt items, then receipt
  await supabase.from("po_delivery_receipt_items").delete().eq("delivery_receipt_id", deliveryId);
  await supabase.from("po_delivery_receipts").delete().eq("id", deliveryId).eq("po_id", poId);

  // Recalculate PO status based on remaining quantities
  const { data: updatedItems } = await supabase
    .from("purchase_order_items")
    .select("quantity_ordered, quantity_received")
    .eq("po_id", poId);

  const anyReceived = (updatedItems ?? []).some((i) => Number(i.quantity_received) > 0);
  const allReceived = (updatedItems ?? []).every(
    (i) => Number(i.quantity_received) >= Number(i.quantity_ordered)
  );

  const newStatus = allReceived ? "received" : anyReceived ? "partially_received" : "ordered";
  const updatePayload: Record<string, unknown> = { status: newStatus };
  if (newStatus === "ordered") {
    updatePayload.actual_delivery_date = null;
  }

  await supabase.from("purchase_orders").update(updatePayload).eq("id", poId);

  if (po.pr_id) {
    await recalculatePrStatus(supabase, po.pr_id);
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: poId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: po.status, new: newStatus },
      delivery_rejected: { old: null, new: deliveryId },
    },
  });

  return NextResponse.json({ data: { new_status: newStatus } });
}
