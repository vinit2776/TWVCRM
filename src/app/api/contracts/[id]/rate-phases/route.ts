import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const PhaseSchema = z.object({
  phases: z.array(
    z.object({
      phase_order: z.number().int().positive(),
      duration_months: z.number().int().positive(),
      monthly_rate: z.number().nonnegative(),
    })
  ),
});

// PUT /api/contracts/[id]/rate-phases — replace all phases for a contract
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or sales rep can edit rate phases" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = PhaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify contract exists and get base rate for validation
  const { data: contract } = await admin
    .from("contracts").select("id, status, subtotal, total_amount").eq("id", id).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const lockedStatuses = ["active", "renewal_in_progress", "renewed", "expired", "terminated"];
  if (lockedStatuses.includes(contract.status)) {
    return NextResponse.json({ error: "Rate phases cannot be changed once a contract is activated" }, { status: 403 });
  }

  const { phases } = parsed.data;
  const baseRate = Number(contract.subtotal || contract.total_amount || 0);
  const belowBase = phases.find((p) => p.monthly_rate < baseRate);
  if (belowBase) {
    return NextResponse.json(
      { error: `Phase ${belowBase.phase_order} rate (₹${belowBase.monthly_rate}) cannot be lower than the contracted monthly fee (₹${baseRate})` },
      { status: 400 }
    );
  }

  // Replace all phases atomically: delete existing, insert new
  const { error: deleteErr } = await admin
    .from("contract_rate_phases").delete().eq("contract_id", id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  if (phases.length > 0) {
    const { error: insertErr } = await admin.from("contract_rate_phases").insert(
      phases.map((p) => ({ contract_id: id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate }))

    );
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  logAudit(admin, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { rate_phases: { old: "replaced", new: phases } },
  });

  return NextResponse.json({ success: true, count: phases.length });
}
