import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

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

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "sales_rep", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, sales_rep, or accounts can update invoices" }, { status: 403 });
  }

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.status) allowedFields.status = body.status;
  if (body.paid_at) allowedFields.paid_at = body.paid_at;
  if (body.payment_reference) allowedFields.payment_reference = body.payment_reference;

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  // Marking paid is payment recording — same roles as POST /api/invoices/[id]/payment.
  const touchesPayment = allowedFields.status === "paid" || body.paid_at || body.payment_reference;
  if (touchesPayment && !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can mark invoices paid" }, { status: 403 });
  }

  const { data: oldInvoice } = await supabase.from("proforma_invoices").select("*").eq("id", id).single();

  const { data, error } = await supabase
    .from("proforma_invoices")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser?.id && oldInvoice) {
    logAudit(supabase, {
      entityType: "invoice",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldInvoice as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}
