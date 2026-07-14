import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager role required" }, { status: 403 });
  }

  // Verify bill exists and is a landlord draft
  const { data: bill } = await supabase
    .from("electricity_bills")
    .select("id, bill_side, status, location_id, bill_month, bill_year, vendor_bill_id")
    .eq("id", id)
    .single();

  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (bill.bill_side !== "landlord") {
    return NextResponse.json({ error: "Only landlord bills can be approved" }, { status: 422 });
  }
  if (bill.status !== "draft") {
    return NextResponse.json({ error: `Bill is already ${bill.status}` }, { status: 409 });
  }

  // Call the atomic RPC
  const { data: result, error } = await supabase
    .rpc("approve_electricity_landlord_bill", { p_landlord_bill_id: id, p_approved_by: dbUser.id });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const customerBillsGenerated = (result as { customer_bills_generated: number }).customer_bills_generated;

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "draft", new: "invoiced" },
      customer_bills_generated: { old: null, new: customerBillsGenerated },
    },
  });

  // No contract mapped at this location — the RPC auto-approved the linked
  // vendor bill so it's immediately payable in Acc Payables, skipping the
  // usual separate Procurement approval step. Audit that decision too.
  if (!customerBillsGenerated && bill.vendor_bill_id) {
    await logAudit(supabase, {
      entityType: "vendor_bill",
      entityId: bill.vendor_bill_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        approval_status: { old: "pending", new: "approved" },
        note: { old: null, new: "Auto-approved on electricity bill approval — no contract mapped at this location" },
      },
    });
  }

  return NextResponse.json({ data: result });
}
