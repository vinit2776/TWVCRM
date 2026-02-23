import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

/**
 * GET: Get invoice detail
 * PATCH: Update invoice (send / mark paid / cancel)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("aggregator_invoices")
    .select(
      "*, aggregator:aggregators!aggregator_invoices_aggregator_id_fkey(id, name, code, primary_email, billing_address, billing_city, billing_state, billing_pincode, gst_number)"
    )
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const action = body.action as string;

  // Fetch current invoice
  const { data: oldInvoice, error: fetchError } = await supabase
    .from("aggregator_invoices")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !oldInvoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const updateData: Record<string, unknown> = {};

  switch (action) {
    case "send":
      if (oldInvoice.status !== "draft") {
        return NextResponse.json(
          { error: "Can only send draft invoices" },
          { status: 400 }
        );
      }
      updateData.status = "sent";
      updateData.sent_at = new Date().toISOString();
      updateData.sent_to = body.email || null;

      // Set due date to 15 days from now if not set
      if (!oldInvoice.due_date) {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 15);
        updateData.due_date = dueDate.toISOString();
      }
      break;

    case "mark_paid":
      if (!["sent", "overdue"].includes(oldInvoice.status)) {
        return NextResponse.json(
          { error: "Can only mark sent or overdue invoices as paid" },
          { status: 400 }
        );
      }
      updateData.status = "paid";
      updateData.paid_at = new Date().toISOString();
      updateData.payment_reference = body.payment_reference || null;
      break;

    case "mark_overdue":
      if (oldInvoice.status !== "sent") {
        return NextResponse.json(
          { error: "Can only mark sent invoices as overdue" },
          { status: 400 }
        );
      }
      updateData.status = "overdue";
      break;

    case "cancel":
      if (oldInvoice.status === "paid") {
        return NextResponse.json(
          { error: "Cannot cancel a paid invoice" },
          { status: 400 }
        );
      }
      updateData.status = "cancelled";
      break;

    default:
      // Allow direct field updates for non-action patches
      if (body.notes !== undefined) updateData.notes = body.notes;
      if (body.due_date !== undefined) updateData.due_date = body.due_date;
      break;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json(
      { error: "No valid updates provided" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("aggregator_invoices")
    .update(updateData)
    .eq("id", id)
    .select(
      "*, aggregator:aggregators!aggregator_invoices_aggregator_id_fkey(id, name, code)"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "aggregator_invoice",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(
        oldInvoice as Record<string, unknown>,
        updateData
      ),
    });
  }

  return NextResponse.json({ data });
}
