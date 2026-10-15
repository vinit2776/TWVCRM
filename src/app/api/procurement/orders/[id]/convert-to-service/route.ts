import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { checkConvertToService } from "@/lib/procurement/convert-to-service";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const bodySchema = z.object({
  billing_cycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]),
  cycle_count: z.number().int().min(1).max(60),
  service_start_date: dateStr,
  /** The existing invoice to tie to cycle 1; omit to convert without one. */
  bill_id: z.string().uuid().nullish(),
  cycle1_from: dateStr.nullish(),
  cycle1_to: dateStr.nullish(),
});

/**
 * Converts an AMC that was raised as a goods PO into a service PO (admin only).
 * The change itself is one database function (convert_goods_po_to_service, 00596) so
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

  const [{ count: reportCount }, billRes] = await Promise.all([
    supabase.from("po_service_reports").select("id", { count: "exact", head: true }).eq("po_id", id),
    b.bill_id
      ? supabase.from("vendor_bills").select("po_id, service_report_id, approval_status, total_amount").eq("id", b.bill_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const verdict = checkConvertToService({
    role: dbUser.role,
    po: { po_type: po.po_type, status: po.status, total_ordered_amount: po.total_ordered_amount, amc_terminated_at: po.amc_terminated_at, isAmc },
    existingReports: reportCount ?? 0,
    billingCycle: b.billing_cycle,
    cycleCount: b.cycle_count,
    serviceStart: b.service_start_date,
    bill: b.bill_id ? billRes.data ?? { po_id: null, service_report_id: null, approval_status: "rejected", total_amount: 0 } : null,
    poId: id,
    cycle1From: b.cycle1_from,
    cycle1To: b.cycle1_to,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });

  const admin = createAdminClient();
  const { data: reportId, error } = await admin.rpc("convert_goods_po_to_service", {
    p_po_id: id,
    p_user_id: dbUser.id,
    p_billing_cycle: b.billing_cycle,
    p_cycle_count: b.cycle_count,
    p_unit_cost: verdict.unitCost,
    p_service_start: b.service_start_date,
    p_bill_id: b.bill_id ?? null,
    p_c1_from: b.cycle1_from ?? null,
    p_c1_to: b.cycle1_to ?? null,
  });
  if (error) {
    // The function raises plain-English messages for every rule; anything else is a real fault.
    const isRule = error.code === "P0001";
    return NextResponse.json({ error: isRule ? error.message : "Couldn't convert this purchase order" }, { status: isRule ? 422 : 500 });
  }

  return NextResponse.json({ data: { id, report_id: reportId ?? null } });
}
