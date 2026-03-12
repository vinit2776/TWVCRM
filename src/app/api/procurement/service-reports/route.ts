import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createSchema = z.object({
  po_id: z.string().uuid(),
  cycle_number: z.number().int().positive(),
  period_from: z.string().min(1, "Period start is required"),
  period_to: z.string().min(1, "Period end is required"),
  report_file_url: z.string().url().nullish(),
  notes: z.string().nullish(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const poId = searchParams.get("po_id");
  if (!poId) return NextResponse.json({ error: "po_id is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("po_service_reports")
    .select("*, recorder:users!po_service_reports_recorded_by_fkey(id, full_name)")
    .eq("po_id", poId)
    .order("cycle_number", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Validate PO exists and is a service PO
  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_type, status")
    .eq("id", parsed.data.po_id)
    .single();

  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
  if (po.po_type !== "service") {
    return NextResponse.json({ error: "Service reports can only be added to service purchase orders" }, { status: 422 });
  }
  if (["cancelled"].includes(po.status)) {
    return NextResponse.json({ error: "Cannot add a service report to a cancelled order" }, { status: 422 });
  }

  // Check for duplicate cycle number
  const { count: dupCount } = await supabase
    .from("po_service_reports")
    .select("*", { count: "exact", head: true })
    .eq("po_id", parsed.data.po_id)
    .eq("cycle_number", parsed.data.cycle_number);

  if (dupCount && dupCount > 0) {
    return NextResponse.json({ error: `A service report for cycle ${parsed.data.cycle_number} already exists` }, { status: 422 });
  }

  const { data: report, error } = await supabase
    .from("po_service_reports")
    .insert({
      po_id: parsed.data.po_id,
      cycle_number: parsed.data.cycle_number,
      period_from: parsed.data.period_from,
      period_to: parsed.data.period_to,
      report_file_url: parsed.data.report_file_url ?? null,
      notes: parsed.data.notes ?? null,
      recorded_by: dbUser.id,
    })
    .select("id, cycle_number")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: parsed.data.po_id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      service_report_added: { old: null, new: `Cycle ${report.cycle_number}` },
    },
  });

  return NextResponse.json({ data: report }, { status: 201 });
}
