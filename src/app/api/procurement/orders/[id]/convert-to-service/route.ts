import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { checkConvertToService } from "@/lib/procurement/convert-to-service";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const bodySchema = z.object({
  billing_cycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]),
  cycle_count: z.number().int().min(1).max(60),
  service_start_date: dateStr,
  /** Existing invoices tied to their cycles (1..k, no gaps); omit to convert without tying any. */
  assignments: z.array(z.object({
    bill_id: z.string().uuid(),
    cycle_number: z.number().int().min(1).max(60),
    period_from: dateStr,
    period_to: dateStr,
  })).max(60).default([]),
});

/**
 * Converts an AMC that was raised as a goods PO into a service PO (admin only).
 * The change itself is one database function (convert_goods_po_to_service_v2, 00667) so
 * it applies fully or not at all; this route authenticates, re-checks the rules to give
 * a readable error, and calls it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can convert a purchase order to a service contract" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const fe = parsed.error.flatten().fieldErrors;
    const message = Object.entries(fe).map(([f, e]) => `${f}: ${(e ?? []).join(", ")}`).join("; ") || "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const b = parsed.data;

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_type, status, total_ordered_amount, amc_start_date, amc_terminated_at, purchase_requests(department, expenditure_type)")
    .eq("id", id)
    .single();
  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  const pr = Array.isArray(po.purchase_requests) ? po.purchase_requests[0] : po.purchase_requests;
  const isAmc = !!po.amc_start_date || pr?.expenditure_type === "amc" || pr?.department === "amc";

  const [{ count: reportCount }, billsRes] = await Promise.all([
    supabase.from("po_service_reports").select("id", { count: "exact", head: true }).eq("po_id", id),
    b.assignments.length
      ? supabase.from("vendor_bills").select("id, po_id, service_report_id, approval_status, total_amount").in("id", b.assignments.map((a) => a.bill_id))
      : Promise.resolve({ data: [] as Array<{ id: string; po_id: string | null; service_report_id: string | null; approval_status: string; total_amount: number }> }),
  ]);
  const billById = new Map((billsRes.data ?? []).map((x) => [x.id, x]));

  const verdict = checkConvertToService({
    role: dbUser.role,
    po: { po_type: po.po_type, status: po.status, total_ordered_amount: po.total_ordered_amount, amc_terminated_at: po.amc_terminated_at, isAmc },
    existingReports: reportCount ?? 0,
    billingCycle: b.billing_cycle,
    cycleCount: b.cycle_count,
    serviceStart: b.service_start_date,
    assignments: b.assignments.map((a) => ({
      billId: a.bill_id,
      cycle: a.cycle_number,
      from: a.period_from,
      to: a.period_to,
      bill: billById.get(a.bill_id) ?? { po_id: null, service_report_id: null, approval_status: "rejected", total_amount: 0 },
    })),
    poId: id,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });

  const admin = createAdminClient();
  const { data: tied, error } = await admin.rpc("convert_goods_po_to_service_v2", {
    p_po_id: id,
    p_user_id: dbUser.id,
    p_billing_cycle: b.billing_cycle,
    p_cycle_count: b.cycle_count,
    p_unit_cost: verdict.unitCost,
    p_service_start: b.service_start_date,
    p_assignments: b.assignments.map((a) => ({
      bill_id: a.bill_id, cycle_number: a.cycle_number, period_from: a.period_from, period_to: a.period_to,
    })),
  });
  if (error) {
    // The function raises plain-English messages for every rule; anything else is a real fault.
    const isRule = error.code === "P0001";
    return NextResponse.json({ error: isRule ? error.message : "Couldn't convert this purchase order" }, { status: isRule ? 422 : 500 });
  }

  return NextResponse.json({ data: { id, invoices_tied: tied ?? 0 } });
}
