import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";

const patchPoSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_ordered") }),
  z.object({
    action: z.literal("mark_received"),
    actual_delivery_date: z.string().nullish(),
  }),
  z.object({ action: z.literal("cancel") }),
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
      `*, purchase_order_items(*), procurement_vendors(id, name, contact_name, contact_phone, contact_email), locations(id, name), orderer:users!purchase_orders_ordered_by_fkey(id, full_name, email), purchase_requests(id, pr_number, department, approval_code, approved_at, approver:users!purchase_requests_approved_by_fkey(id, full_name, email))`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  return NextResponse.json({ data });
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
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_orders")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(po as Record<string, unknown>, { ...po, ...updatePayload } as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}
