import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { EXIT_CHARGE_ROLES, EXIT_CHARGE_TYPES } from "@/lib/contract-exit";
import { getLiveExit } from "@/lib/contract-exit-server";
import { getLiveSettlement } from "@/lib/exit-settlement-server";

const schema = z.object({
  charge_type: z.enum(EXIT_CHARGE_TYPES),
  description: z.string().trim().min(1, "Describe the charge"),
  amount: z.number().positive("Enter an amount above zero").max(10_000_000),
});

/** POST /api/contracts/[id]/exit/charges — add an inspection charge. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(EXIT_CHARGE_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "You can't add inspection charges." }, { status: 403 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const exit = await getLiveExit(admin, id);
  if (!exit) return NextResponse.json({ error: "No exit in progress for this contract." }, { status: 404 });
  if (await getLiveSettlement(admin, exit.id)) {
    return NextResponse.json({ error: "Charges are locked: this exit has been sent for admin approval." }, { status: 409 });
  }

  const { data: row, error } = await admin
    .from("contract_exit_charges")
    .insert({ exit_id: exit.id, ...parsed.data, added_by: me.id })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "contract", entityId: id, action: "exit_charge_added", performedBy: me.id,
    changes: { charge: { old: null, new: `${parsed.data.charge_type}: ${parsed.data.description} ₹${parsed.data.amount}` } },
  });
  return NextResponse.json({ data: { id: row.id } }, { status: 201 });
}
