import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";
import { recalculatePrStatus } from "@/lib/procurement/pr-status";

const patchPoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_ordered") }),
  z.object({
    action: z.literal("mark_received"),
    actual_delivery_date: z.string().nullish(),
  }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("partial_cancel"),
    confirmed_items: z.array(z.object({
      po_item_id: z.string().uuid(),
      confirmed_qty: z.number().min(0),
    })).min(1),
  }),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("purchase_orders")
    .select(
      `*, purchase_order_items(*, procurement_items(id, name, description)), procurement_vendors(id, name, contact_name, contact_phone, contact_email), locations(id, name), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), purchase_requests(id, pr_number, department, approval_code, approved_at, approver:users!purchase_requests_approved_by_fkey(id, full_name, email)), po_delivery_receipts(*, receiver:users!po_delivery_receipts_received_by_fkey(id, full_name, email), po_delivery_receipt_items(id, po_item_id, qty_received)), vendor_bills(id, bill_number, invoice_date, invoice_file_url, total_amount, payment_status, created_at, creator:users!vendor_bills_created_by_fkey(id, full_name))`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  // Fetch audit trail for this PO (for activity timeline)
  const { data: auditEvents } = await supabase
    .from("audit_trail")
    .select("id, action, changes, performed_by, created_at, performer:users!audit_trail_performed_by_fkey(id, full_name)")
    .eq("entity_type", "purchase_order")
    .eq("entity_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ data, audit_events: auditEvents ?? [] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: po, error: fetchError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchPoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  let updatePayload: Record<string, unknown> = {};

  switch (action) {
    case "mark_ordered": {
      if (po.status !== "pending") {
        return NextResponse.json({ error: "Only pending POs can be marked as ordered" }, { status: 422 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can mark orders as ordered" }, { status: 403 });
      }
      updatePayload = { status: "ordered" };
      break;
    }

    case "mark_received": {
      if (!["ordered", "partially_received"].includes(po.status)) {
        return NextResponse.json({ error: "Only ordered or partially received POs can be marked as received" }, { status: 422 });
      }
      if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only floor managers, managers, and admins can mark orders as received" }, { status: 403 });
      }
      const today = new Date().toISOString().split("T")[0];
      updatePayload = {
        status: "received",
        actual_delivery_date: parsed.data.actual_delivery_date ?? today,
      };
      break;
    }

    case "cancel": {
      if (!["pending", "ordered"].includes(po.status)) {
        return NextResponse.json({ error: "Only pending or ordered POs can be cancelled" }, { status: 422 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can cancel purchase orders" }, { status: 403 });
      }
      updatePayload = { status: "cancelled" };
      break;
    }

    case "partial_cancel": {
      if (po.status !== "invoice_received") {
        return NextResponse.json({ error: "Only invoice_received POs can be partially cancelled" }, { status: 422 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can cancel purchase orders" }, { status: 403 });
      }

      const { confirmed_items } = parsed.data;

      const { data: poItems } = await supabase
        .from("purchase_order_items")
        .select("id, quantity_ordered, unit_price")
        .eq("po_id", id);

      const poItemMap = Object.fromEntries((poItems ?? []).map((i) => [i.id, i]));

      for (const ci of confirmed_items) {
        const poItem = poItemMap[ci.po_item_id];
        if (!poItem) {
          return NextResponse.json({ error: `Item ${ci.po_item_id} not found` }, { status: 422 });
        }
        if (ci.confirmed_qty > Number(poItem.quantity_ordered)) {
          return NextResponse.json({ error: "Confirmed qty exceeds ordered qty" }, { status: 422 });
        }
      }

      // Reduce quantity_ordered to confirmed_qty on each item
      for (const ci of confirmed_items) {
        await supabase.from("purchase_order_items")
          .update({ quantity_ordered: ci.confirmed_qty })
          .eq("id", ci.po_item_id)
          .eq("po_id", id);
      }

      // Recompute PO total
      const { data: updatedItems } = await supabase
        .from("purchase_order_items")
        .select("quantity_ordered, unit_price")
        .eq("po_id", id);
      const newTotal = (updatedItems ?? []).reduce(
        (s, i) => s + Number(i.quantity_ordered) * Number(i.unit_price ?? 0), 0
      );

      updatePayload = { status: "partially_cancelled", total_ordered_amount: newTotal };
      break;
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_orders")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  // Recalculate PR status after any cancellation so remaining qty is freed
  if (["cancel", "partial_cancel"].includes(action) && po.pr_id) {
    await recalculatePrStatus(supabase, po.pr_id);
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(po as Record<string, unknown>, { ...po, ...updatePayload } as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}
