import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/contracts/[id]/quotas
 * Returns the contract's service quotas joined with the catalog item.
 * Frontend uses this to render the Quotas tab on the contract detail page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_service_quotas")
    .select(`
      *,
      service:service_catalog(id, slug, name, unit_label, default_overage_rate, gst_rate, printer_column, sort_order)
    `)
    .eq("contract_id", id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/contracts/[id]/quotas
 * Body: { service_id, monthly_quota, overage_rate, notes? }
 *
 * UPSERT semantics — if a row exists for (contract, service) we update; else
 * insert. This is what the contract detail "Quotas" tab calls when an admin
 * sets or edits a quota.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  // Active (and beyond) contracts: only admin may change quotas
  if (dbUser.role !== "admin") {
    const { data: contract } = await supabase.from("contracts").select("status").eq("id", id).single();
    const lockStatuses = ["active", "renewal_in_progress", "renewed", "completed", "terminated", "expired"];
    if (contract && lockStatuses.includes(contract.status)) {
      return NextResponse.json({ error: "Quotas on an active contract can only be changed by an admin." }, { status: 403 });
    }
  }

  const body = await request.json();
  const { service_id, monthly_quota, overage_rate, notes } = body;

  if (!service_id) return NextResponse.json({ error: "service_id is required" }, { status: 400 });
  if (monthly_quota == null || isNaN(Number(monthly_quota)) || Number(monthly_quota) < 0) {
    return NextResponse.json({ error: "monthly_quota must be a non-negative number" }, { status: 400 });
  }
  if (overage_rate == null || isNaN(Number(overage_rate)) || Number(overage_rate) < 0) {
    return NextResponse.json({ error: "overage_rate must be a non-negative number" }, { status: 400 });
  }

  // Upsert via the unique (contract_id, service_id) constraint
  const { data, error } = await supabase
    .from("contract_service_quotas")
    .upsert({
      contract_id: id,
      service_id,
      monthly_quota: Number(monthly_quota),
      overage_rate: Number(overage_rate),
      notes: notes || null,
      created_by: dbUser.id,
    }, { onConflict: "contract_id,service_id" })
    .select(`
      *,
      service:service_catalog(id, slug, name, unit_label, default_overage_rate, gst_rate, printer_column, sort_order)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_service_quota",
    entityId: data.id,
    action: "update",   // upsert — could be either; "update" is the more common case
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data });
}

/**
 * DELETE /api/contracts/[id]/quotas?quota_id=...
 * Removes a specific quota row (e.g. customer no longer entitled to that service).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  if (dbUser.role !== "admin") {
    const { data: contract } = await supabase.from("contracts").select("status").eq("id", id).single();
    const lockStatuses = ["active", "renewal_in_progress", "renewed", "completed", "terminated", "expired"];
    if (contract && lockStatuses.includes(contract.status)) {
      return NextResponse.json({ error: "Quotas on an active contract can only be changed by an admin." }, { status: 403 });
    }
  }

  const quotaId = request.nextUrl.searchParams.get("quota_id");
  if (!quotaId) return NextResponse.json({ error: "quota_id is required" }, { status: 400 });

  const { error } = await supabase
    .from("contract_service_quotas")
    .delete()
    .eq("id", quotaId)
    .eq("contract_id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_service_quota", entityId: quotaId, action: "delete",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ success: true });
}
