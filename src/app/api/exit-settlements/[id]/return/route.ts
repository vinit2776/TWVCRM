import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { SETTLEMENT_APPROVE_ROLES } from "@/lib/exit-settlement";
import { loadSettlementForAction, notifyRoles, requireRole } from "@/lib/exit-settlement-server";

const schema = z.object({ reason: z.string().trim().min(1, "A reason is required") });

/** POST /api/exit-settlements/[id]/return — admin sends it back; the charges unlock. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(SETTLEMENT_APPROVE_ROLES, "Only an admin can return an exit settlement.");
  if ("error" in auth) return auth.error;
  const { me } = auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const loaded = await loadSettlementForAction(admin, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { settlement, contractNumber, customer } = loaded;

  const { data: updated, error } = await admin
    .from("exit_settlements")
    .update({ status: "returned", returned_by: me.id, returned_at: new Date().toISOString(), return_reason: parsed.data.reason, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "pending_approval").select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) return NextResponse.json({ error: "Only a settlement awaiting approval can be returned." }, { status: 409 });

  logAudit(admin, {
    entityType: "contract", entityId: settlement.contract_id, action: "exit_returned", performedBy: me.id,
    changes: { status: { old: "pending_approval", new: "returned" }, reason: { old: null, new: parsed.data.reason } },
  });
  await notifyRoles(admin, [], [settlement.cleared_by], {
    title: `Exit returned for changes: ${customer} (${contractNumber})`,
    body: parsed.data.reason, url: `/contracts/${settlement.contract_id}/exit`, contractId: settlement.contract_id,
  });
  return NextResponse.json({ ok: true });
}
