import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

// ── GET  /api/contracts/[id]/facilities ──────────────────────────────────────
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

// ── POST  /api/contracts/[id]/facilities ─────────────────────────────────────
// Creates a new facility row (or upserts by name if the name already exists).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const ALLOWED = ["admin", "manager", "accounts"];
  if (!dbUser || !ALLOWED.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  return NextResponse.json({ data }, { status: 201 });
}

// ── PATCH  /api/contracts/[id]/facilities ─────────────────────────────────────
// Updates free_quota and/or cost_per_unit for an existing facility.
// If free_quota changed, recalculates pending usage_charges for the current
// billing month so bookings that are now within quota get waived.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const ALLOWED = ["admin", "manager", "accounts"];
  if (!dbUser || !ALLOWED.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const result = patchSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues.map(i => i.message).join("; ") }, { status: 400 });
  }

  const { facility_id, free_quota, cost_per_unit } = result.data;

  // Read current state before updating (for audit + recalc decision)
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

  // ── Recalculation trigger ─────────────────────────────────────────────────
  // When free_quota changes, re-score all pending/waived usage_charges that
  // are linked to this facility in the current calendar month.
  // Sort them chronologically and accumulate hours: the first N hours within
  // quota are waived (total=0, unit_price=0), hours beyond are re-priced.
  if (free_quota !== prev.free_quota) {
    try {
      await recalcFacilityCharges(supabase, facility_id, free_quota, cost_per_unit, contractId);
    } catch (err) {
      // Recalc failure is non-fatal — the quota row is already updated.
      console.error("[facilities] recalc failed:", err);
    }
  }

  return NextResponse.json({ data: updated });
}

// ── DELETE  /api/contracts/[id]/facilities ─────────────────────────────────
// Soft-deletes (is_active = false). Hard delete is not safe — leaves booking
// history orphaned and breaks the quota description in old usage_charges.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const ALLOWED = ["admin", "manager", "accounts"];
  if (!dbUser || !ALLOWED.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

// ── Recalculation helper ─────────────────────────────────────────────────────
// Re-scores usage_charges linked to this facility in the current month.
// Sorts by charge_date ASC to preserve chronological priority.
async function recalcFacilityCharges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  facilityId: string,
  newFreeQuota: number,
  newCostPerUnit: number,
  contractId: string,
) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  // Fetch usage_charges for this facility in the current month that are still
  // modifiable (pending or waived — not posted_to_bill, cancelled, etc.)
  const { data: charges, error } = await supabase
    .from("usage_charges")
    .select("id, quantity, charge_date, status")
    .eq("contract_id", contractId)
    .eq("contract_facility_id", facilityId)
    .in("status", ["pending", "waived"])
    .gte("charge_date", monthStart)
    .lte("charge_date", monthEnd)
    .order("charge_date", { ascending: true });

  if (error || !charges || charges.length === 0) return;

  let consumed = 0;
  for (const charge of charges) {
    const qty = Number(charge.quantity);
    const freeRemaining = Math.max(0, newFreeQuota - consumed);
    const overage = Math.max(0, qty - freeRemaining);
    consumed += qty;

    const newStatus = overage > 0 ? "pending" : "waived";
    const newUnitPrice = overage > 0 ? newCostPerUnit : 0;
    const newTotal = parseFloat((overage * newCostPerUnit).toFixed(2));
    const newQty = overage > 0 ? overage : qty;

    await supabase
      .from("usage_charges")
      .update({
        status: newStatus,
        quantity: newQty,
        unit_price: newUnitPrice,
        total: newTotal,
      })
      .eq("id", charge.id);
  }
}
