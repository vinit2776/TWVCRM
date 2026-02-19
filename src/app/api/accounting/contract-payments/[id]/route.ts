import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Fetch payment
  const { data: payment, error: fetchError } = await supabase
    .from("contract_payments")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  const body = await request.json();
  const { action, notes, gst_invoice_number } = body as {
    action?: "verify" | "reject" | "confirm_handover";
    notes?: string;
    gst_invoice_number?: string;
  };

  // GST invoice number update (allowed even when period is locked)
  if (gst_invoice_number !== undefined && !action) {
    const updates: Record<string, unknown> = {
      gst_invoice_number: gst_invoice_number.trim(),
    };
    // Set status to invoiced if we have a number and no path yet
    if (gst_invoice_number.trim() && !payment.gst_invoice_path) {
      updates.gst_invoice_status = "invoiced";
    }

    const { data: updated, error: updateError } = await supabase
      .from("contract_payments")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { gst_invoice_number: { old: payment.gst_invoice_number, new: gst_invoice_number.trim() } },
    });

    return NextResponse.json({ data: updated });
  }

  if (!action) {
    return NextResponse.json({ error: "Action is required (verify, reject, confirm_handover) or provide gst_invoice_number" }, { status: 400 });
  }

  // Verify payment
  if (action === "verify") {
    if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
    if (payment.status !== "pending") {
      return NextResponse.json({ error: "Only pending payments can be verified" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("contract_payments")
      .update({
        status: "verified",
        screenshot_verified: true,
      })
      .eq("id", id)
      .select("*, creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "pending", new: "verified" } },
    });

    return NextResponse.json({ data: updated });
  }

  // Reject payment
  if (action === "reject") {
    if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
    if (payment.status !== "pending") {
      return NextResponse.json({ error: "Only pending payments can be rejected" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("contract_payments")
      .update({
        status: "rejected",
        screenshot_verified: false,
        notes: notes ? `${payment.notes ? payment.notes + "\n" : ""}Rejection: ${notes}` : payment.notes,
      })
      .eq("id", id)
      .select("*, creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "pending", new: "rejected" }, notes: { old: payment.notes, new: notes } },
    });

    return NextResponse.json({ data: updated });
  }

  // Confirm cash handover
  if (action === "confirm_handover") {
    if (!["admin", "manager", "floor_manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
    if (payment.cash_handover_status !== "pending_handover") {
      return NextResponse.json({ error: "Only pending handovers can be confirmed" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("contract_payments")
      .update({
        cash_handover_status: "handed_over",
        handed_over_to: dbUser.id,
        handed_over_at: new Date().toISOString(),
        handover_confirmed_by: dbUser.id,
        handover_confirmed_at: new Date().toISOString(),
        handover_notes: notes || null,
      })
      .eq("id", id)
      .select("*, creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { cash_handover_status: { old: "pending_handover", new: "handed_over" } },
    });

    return NextResponse.json({ data: updated });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
