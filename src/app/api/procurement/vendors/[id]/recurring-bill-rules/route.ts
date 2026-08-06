import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RECURRING_BILL_RULE_DEPARTMENTS, PAYMENT_BATCH_TYPES } from "@/lib/constants";

const SERVICE_PO_BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;

const createRuleSchema = z.object({
  department: z.enum(RECURRING_BILL_RULE_DEPARTMENTS),
  billing_cycle: z.enum(SERVICE_PO_BILLING_CYCLES),
  anchor_bill_id: z.string().uuid(),
  tolerance_percent: z.number().min(0).max(100).default(10),
  max_auto_approve_amount: z.number().positive().default(5000),
  default_batch_type: z.enum(PAYMENT_BATCH_TYPES),
  notes: z.string().max(1000).nullish(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: vendorId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin", "accounts", "viewer"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("procurement_recurring_bill_rules")
    .select(
      `*, anchor_bill:vendor_bills!procurement_recurring_bill_rules_anchor_bill_id_fkey(id, bill_number, total_amount, invoice_date),
       creator:users!procurement_recurring_bill_rules_created_by_fkey(id, full_name)`
    )
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: vendorId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can set up a recurring bill rule" }, { status: 403 });
  }

  const parsed = createRuleSchema.safeParse(await request.json());
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const msg = Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    return NextResponse.json({ error: msg || "Invalid request data" }, { status: 400 });
  }
  const input = parsed.data;

  const { data: vendor } = await supabase.from("procurement_vendors").select("id").eq("id", vendorId).single();
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  // The rule can only be seeded from a real, already-approved bill from this
  // vendor — it cannot be set up speculatively ahead of any invoice.
  const { data: anchorBill } = await supabase
    .from("vendor_bills")
    .select("id, vendor_id, total_amount, approval_status")
    .eq("id", input.anchor_bill_id)
    .single();
  if (!anchorBill || anchorBill.vendor_id !== vendorId) {
    return NextResponse.json({ error: "Anchor bill not found for this vendor" }, { status: 400 });
  }
  if (anchorBill.approval_status !== "approved") {
    return NextResponse.json({ error: "Anchor bill must already be manually approved" }, { status: 400 });
  }

  const { data: existingActive } = await supabase
    .from("procurement_recurring_bill_rules")
    .select("id")
    .eq("vendor_id", vendorId)
    .eq("status", "active")
    .maybeSingle();
  if (existingActive) {
    return NextResponse.json(
      { error: "This vendor already has an active recurring bill rule. Pause it before creating a new one." },
      { status: 409 }
    );
  }

  const { data: rule, error: insertError } = await supabase
    .from("procurement_recurring_bill_rules")
    .insert({
      vendor_id: vendorId,
      department: input.department,
      billing_cycle: input.billing_cycle,
      expected_amount: anchorBill.total_amount,
      tolerance_percent: input.tolerance_percent,
      max_auto_approve_amount: input.max_auto_approve_amount,
      default_batch_type: input.default_batch_type,
      anchor_bill_id: anchorBill.id,
      notes: input.notes ?? null,
      created_by: dbUser.id,
    })
    .select("*")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "recurring_bill_rule",
    entityId: rule.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      vendor_id: { old: null, new: vendorId },
      expected_amount: { old: null, new: rule.expected_amount },
      tolerance_percent: { old: null, new: rule.tolerance_percent },
      max_auto_approve_amount: { old: null, new: rule.max_auto_approve_amount },
      anchor_bill_id: { old: null, new: anchorBill.id },
    },
  });

  return NextResponse.json({ data: rule }, { status: 201 });
}
