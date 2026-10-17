import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { EXIT_CHARGE_ROLES, EXIT_CHARGE_TYPES } from "@/lib/contract-exit";
import { getLiveExit } from "@/lib/contract-exit-server";

const schema = z.object({
  charge_type: z.enum(EXIT_CHARGE_TYPES).optional(),
  description: z.string().trim().min(1).optional(),
  amount: z.number().positive().max(10_000_000).optional(),
});

async function guard(id: string, chargeId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(EXIT_CHARGE_ROLES as readonly string[]).includes(me.role)) {
    return { error: NextResponse.json({ error: "You can't change inspection charges." }, { status: 403 }) };
  }
  const admin = createAdminClient();
  const exit = await getLiveExit(admin, id);
  if (!exit) return { error: NextResponse.json({ error: "No exit in progress for this contract." }, { status: 404 }) };
  const { data: charge } = await admin.from("contract_exit_charges").select("*").eq("id", chargeId).eq("exit_id", exit.id).single();
  if (!charge) return { error: NextResponse.json({ error: "Charge not found." }, { status: 404 }) };
  return { me, admin, charge };
}

/** PATCH — edit a charge. Marks it edited so the approver can see it. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; chargeId: string }> }) {
  const { id, chargeId } = await params;
  const g = await guard(id, chargeId);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: parsed.success ? "Nothing to change." : parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { error } = await g.admin
    .from("contract_exit_charges")
    .update({ ...parsed.data, updated_by: g.me.id, updated_at: new Date().toISOString(), edited_after_add: true })
    .eq("id", chargeId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(g.admin, {
    entityType: "contract", entityId: id, action: "exit_charge_updated", performedBy: g.me.id,
    changes: Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k, { old: (g.charge as Record<string, unknown>)[k], new: v }])),
  });
  return NextResponse.json({ ok: true });
}

/** DELETE — remove a charge. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; chargeId: string }> }) {
  const { id, chargeId } = await params;
  const g = await guard(id, chargeId);
  if ("error" in g) return g.error;
  const { error } = await g.admin.from("contract_exit_charges").delete().eq("id", chargeId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const c = g.charge as { charge_type: string; description: string; amount: number };
  logAudit(g.admin, {
    entityType: "contract", entityId: id, action: "exit_charge_removed", performedBy: g.me.id,
    changes: { charge: { old: `${c.charge_type}: ${c.description} ₹${c.amount}`, new: null } },
  });
  return NextResponse.json({ ok: true });
}
