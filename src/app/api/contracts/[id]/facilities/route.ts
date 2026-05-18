import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { CONTRACT_QUOTA_LOCKED_STATUSES, CONTRACT_QUOTA_ROLES } from "@/lib/constants";

const upsertSchema = z.object({
  name: z.string().min(1).max(100),
  unit: z.string().min(1).max(50),
  free_quota: z.number().min(0),
  cost_per_unit: z.number().min(0),
});

const patchSchema = z.object({
  facility_id: z.string().uuid(),
  free_quota: z.number().min(0),
  cost_per_unit: z.number().min(0),
});

// Roles that can ever edit quotas (imported from constants, includes sales_rep)
const QUOTA_ROLES: readonly string[] = CONTRACT_QUOTA_ROLES;

// On an active (or beyond) contract, only admin may change quotas.
// Returns an error response if the caller is not allowed, else null.
async function enforceActiveGate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  contractId: string,
  userRole: string,
): Promise<NextResponse | null> {
  if (userRole === "admin") return null; // admin always allowed

  const { data: contract, error } = await supabase
    .from("contracts")
    .select("status")
    .eq("id", contractId)
    .single();

  if (error || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if ((CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status)) {
    return NextResponse.json(
      { error: "Quotas on an active contract can only be changed by an admin." },
      { status: 403 }
    );
  }
  return null;
}

// ── GET ──────────────────────────────────────────────────────────────────────
// Returns active facilities for the contract, with current-month usage data
// (hours used this month from confirmed/checked_in/checked_out bookings).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  // Fetch active facilities + this month's linked bookings in parallel
  const [facilitiesRes, chargesRes] = await Promise.all([
    supabase
      .from("contract_facilities")
      .select("id, name, unit, free_quota, cost_per_unit, is_active, created_at")
      .eq("contract_id", contractId)
      .eq("is_active", true)
      .order("name"),
    // usage_charges → bookings join: get duration_hours per facility this month
    supabase
      .from("usage_charges")
      .select("contract_facility_id, booking:bookings!booking_id(duration_hours, status)")
      .eq("contract_id", contractId)
      .not("contract_facility_id", "is", null)
      .gte("charge_date", monthStart)
      .lte("charge_date", monthEnd),
  ]);

  if (facilitiesRes.error) return NextResponse.json({ error: facilitiesRes.error.message }, { status: 500 });

  // Build a map: facilityId → total hours consumed this month from linked bookings
  const usageByFacility: Record<string, number> = {};
  for (const uc of chargesRes.data || []) {
    const b = uc.booking as unknown as { duration_hours: number | null; status: string } | null;
    if (!b || !["confirmed", "checked_in", "checked_out"].includes(b.status)) continue;
    const fid = uc.contract_facility_id as string;
    usageByFacility[fid] = (usageByFacility[fid] || 0) + Number(b.duration_hours || 0);
  }

  const data = (facilitiesRes.data || []).map((f) => ({
    ...f,
    hours_used_this_month: usageByFacility[f.id] ?? 0,
  }));

  return NextResponse.json({ data, period: { start: monthStart, end: monthEnd } });
}

// ── POST ─────────────────────────────────────────────────────────────────────
// Creates (or re-activates) a facility row, then retroactively recalculates
// any unlinked usage_charges for the current month so existing bookings
// immediately reflect the new quota.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !QUOTA_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const gate = await enforceActiveGate(supabase, contractId, dbUser.role);
  if (gate) return gate;

  const body = await req.json();
  const result = upsertSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues.map(i => i.message).join("; ") }, { status: 400 });
  }

  const d = result.data;
  const { data, error } = await supabase
    .from("contract_facilities")
    .upsert({
      contract_id: contractId,
      name: d.name,
      unit: d.unit,
      free_quota: d.free_quota,
      cost_per_unit: d.cost_per_unit,
      is_active: true,
      created_by: dbUser.id,
    }, { onConflict: "contract_id,name" })
    .select("id, name, unit, free_quota, cost_per_unit")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_facility",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  // Retroactively recalculate this month's charges — use admin client so we
  // can update waived rows that the user-scoped client would reject.
  try {
    const admin = await createAdminClient();
    await recalcFacilityCharges(admin, data.id, d.free_quota, d.cost_per_unit, contractId, true);
  } catch (err) {
    console.error("[facilities] retroactive recalc failed:", err);
  }

  return NextResponse.json({ data }, { status: 201 });
}

// ── PATCH ────────────────────────────────────────────────────────────────────
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !QUOTA_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const gate = await enforceActiveGate(supabase, contractId, dbUser.role);
  if (gate) return gate;

  const body = await req.json();
  const result = patchSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues.map(i => i.message).join("; ") }, { status: 400 });
  }

  const { facility_id, free_quota, cost_per_unit } = result.data;

  const { data: prev, error: fetchErr } = await supabase
    .from("contract_facilities")
    .select("id, name, unit, free_quota, cost_per_unit")
    .eq("id", facility_id)
    .eq("contract_id", contractId)
    .single();

  if (fetchErr || !prev) return NextResponse.json({ error: "Facility not found" }, { status: 404 });

  const { data: updated, error: updateErr } = await supabase
    .from("contract_facilities")
    .update({ free_quota, cost_per_unit })
    .eq("id", facility_id)
    .select("id, name, unit, free_quota, cost_per_unit")
    .single();

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_facility",
    entityId: facility_id,
    action: "update",
    performedBy: dbUser.id,
    changes: { record: { old: prev, new: updated } },
  });

  // Always recalculate when free_quota or cost changes — use admin client
  // so we can reach waived rows too.
  try {
    const admin = await createAdminClient();
    await recalcFacilityCharges(admin, facility_id, free_quota, cost_per_unit, contractId, false);
  } catch (err) {
    console.error("[facilities] recalc failed:", err);
  }

  return NextResponse.json({ data: updated });
}

// ── DELETE ───────────────────────────────────────────────────────────────────
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !QUOTA_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const gate = await enforceActiveGate(supabase, contractId, dbUser.role);
  if (gate) return gate;

  const { searchParams } = new URL(req.url);
  const facilityId = searchParams.get("facility_id");
  if (!facilityId) return NextResponse.json({ error: "facility_id required" }, { status: 400 });

  const { error } = await supabase
    .from("contract_facilities")
    .update({ is_active: false })
    .eq("id", facilityId)
    .eq("contract_id", contractId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_facility",
    entityId: facilityId,
    action: "delete",
    performedBy: dbUser.id,
    changes: { record: { old: { is_active: true }, new: { is_active: false } } },
  });

  return NextResponse.json({ ok: true });
}

// ── Recalculation helper ──────────────────────────────────────────────────────
// Delegates to the `recalc_facility_charges` Postgres RPC (migration 00172).
//
// The RPC runs both steps — retroactive link + rescore loop — inside a single
// transaction with FOR UPDATE row locking, fixing two issues that existed in
// the previous multi-round-trip JS implementation:
//   C2: non-transactional loop (partial crash left charges half-rescored)
//   C3: TOCTOU race between SELECT-unlinked and UPDATE-to-link
async function recalcFacilityCharges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  facilityId: string,
  newFreeQuota: number,
  newCostPerUnit: number,
  contractId: string,
  retroactive: boolean,
) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  const { error } = await admin.rpc("recalc_facility_charges", {
    p_contract_id:       contractId,
    p_facility_id:       facilityId,
    p_new_free_quota:    newFreeQuota,
    p_new_cost_per_unit: newCostPerUnit,
    p_retroactive:       retroactive,
    p_month_start:       monthStart,
    p_month_end:         monthEnd,
  });

  if (error) throw error;
}
