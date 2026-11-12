import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { SETTLEMENT_PAY_ROLES } from "@/lib/exit-settlement";
import { loadSettlementForAction, requireRole } from "@/lib/exit-settlement-server";

const schema = z.object({ reference: z.string().trim().min(1, "Enter the invoice reference") });

/** POST /api/exit-settlements/[id]/owed-handled — accounts notes the invoice raised for what the customer owes. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(SETTLEMENT_PAY_ROLES, "Only accounts or an admin can do this.");
  if ("error" in auth) return auth.error;
  const { me } = auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const loaded = await loadSettlementForAction(admin, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (loaded.settlement.status !== "closed" || loaded.settlement.owed_amount <= 0) {
    return NextResponse.json({ error: "Nothing is owed on this settlement." }, { status: 400 });
  }
  const { error } = await admin.from("exit_settlements")
    .update({ owed_invoice_reference: parsed.data.reference, owed_handled_by: me.id, owed_handled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(admin, {
    entityType: "contract", entityId: loaded.settlement.contract_id, action: "exit_owed_handled", performedBy: me.id,
    changes: { invoice_reference: { old: null, new: parsed.data.reference }, amount: { old: null, new: loaded.settlement.owed_amount } },
  });
  return NextResponse.json({ ok: true });
}
