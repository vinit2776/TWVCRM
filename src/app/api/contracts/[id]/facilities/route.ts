import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

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

// Roles that can ever edit quotas
const QUOTA_ROLES = ["admin", "manager", "accounts"];

// On an active (or beyond) contract, only admin may change quotas.
// Returns an error response if the caller is not allowed, else null.
async function enforceActiveGate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  contractId: string,
  userRole: string,
): Promise<NextResponse | null> {
  if (userRole === "admin") return null; // admin always allowed

  const { data: contract } = await supabase
    .from("contracts")
    .select("status")
    .eq("id", contractId)
    .single();

  const lockStatuses = ["active", "renewal_in_progress", "renewed", "completed", "terminated", "expired"];
  if (contract && lockStatuses.includes(contract.status)) {
    return NextResponse.json(
      { error: "Quotas on an active contract can only be changed by an admin." },
      { status: 403 }
    );
  }
  return null;
}

// ── GET ──────────────────────────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_facilities")
    .select("id, name, unit, free_quota, cost_per_unit, is_active, created_at")
    .eq("contract_id", contractId)
    .eq("is_active", true)
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
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
// Uses the admin client (bypasses RLS) so it can update waived charges too.
//
// retroactive=true (POST / new facility):
//   Also claims charges that have contract_facility_id IS NULL for this contract
//   in the current month — these were created before the facility was set up.
//
// retroactive=false (PATCH / quota change):
//   Only touches charges already linked to this facility (FK match).
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

  // When retroactive: also pick up unlinked charges (null FK) for this contract
  // that haven't been posted to a billing statement yet.
  if (retroactive) {
    const { data: unlinked } = await admin
      .from("usage_charges")
      .select("id")
      .eq("contract_id", contractId)
      .is("contract_facility_id", null)
      .is("billing_statement_id", null)
      .in("status", ["pending", "waived"])
      .gte("charge_date", monthStart)
      .lte("charge_date", monthEnd);

    if (unlinked && unlinked.length > 0) {
      const ids = unlinked.map((c: { id: string }) => c.id);
      await admin
        .from("usage_charges")
        .update({ contract_facility_id: facilityId })
        .in("id", ids);
    }
  }

  // Now fetch ALL charges linked to this facility this month (including ones
  // we just linked above), sorted chronologically.
  const { data: charges, error } = await admin
    .from("usage_charges")
    .select("id, quantity, charge_date, status")
    .eq("contract_id", contractId)
    .eq("contract_facility_id", facilityId)
    .is("billing_statement_id", null)
    .in("status", ["pending", "waived"])
    .gte("charge_date", monthStart)
    .lte("charge_date", monthEnd)
    .order("charge_date", { ascending: true });

  if (error || !charges || charges.length === 0) return;

  // Re-score chronologically against the (new) free quota.
  let consumed = 0;
  for (const charge of charges) {
    const qty = Number(charge.quantity);
    const freeRemaining = Math.max(0, newFreeQuota - consumed);
    const overageQty    = Math.max(0, qty - freeRemaining);
    consumed += qty;

    await admin
      .from("usage_charges")
      .update({
        status:     overageQty > 0 ? "pending" : "waived",
        quantity:   overageQty > 0 ? overageQty : qty,
        unit_price: overageQty > 0 ? newCostPerUnit : 0,
        total:      overageQty > 0 ? parseFloat((overageQty * newCostPerUnit).toFixed(2)) : 0,
      })
      .eq("id", charge.id);
  }
}
