/**
 * POST /api/analytics/centers/projections/adjustments
 *
 * Admin-only. Adds a manual one-off revenue adjustment for a contract's
 * Projections "Confirmed" figure in a given month — for real revenue that
 * exists (invoice raised offline, payment received) but isn't captured by
 * the contract's own start_date/rate_phases, without editing the contract
 * record itself. See supabase/migrations/00530_projection_adjustments.sql
 * for why this stays a separate table instead of backdating the contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const createAdjustmentSchema = z.object({
  contract_id: z.string().uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM"),
  amount: z.number().positive(),
  reason: z.string().trim().min(1, "A reason is required"),
});

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, dbUser: null };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const, dbUser: null };
  }
  return { error: null, status: 200 as const, dbUser };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error || !auth.dbUser) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => null);
  const parsed = createAdjustmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { contract_id, month, amount, reason } = parsed.data;

  const { data: contract, error: contractErr } = await supabase
    .from("contracts").select("id, contract_number, location_id").eq("id", contract_id).single();
  if (contractErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("projection_adjustments")
    .insert({ contract_id, month, amount, reason, created_by: auth.dbUser.id })
    .select("id, contract_id, month, amount, reason, created_at")
    .single();
  if (insertErr) {
    if (insertErr.code === "23505") {
      return NextResponse.json({ error: "An adjustment already exists for this contract and month" }, { status: 409 });
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: contract_id,
    action: "projection_adjustment_added",
    performedBy: auth.dbUser.id,
    changes: {
      month: { old: null, new: month },
      amount: { old: null, new: amount },
      reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: inserted }, { status: 201 });
}
