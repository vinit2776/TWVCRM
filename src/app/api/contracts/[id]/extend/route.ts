import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const MAX_LIFETIME_EXTENSION_DAYS = 60;

const extendSchema = z.object({
  days: z.number().int().min(1).max(MAX_LIFETIME_EXTENSION_DAYS),
  reason: z.string().trim().min(1, "A reason is required"),
});

/**
 * POST /api/contracts/[id]/extend
 *
 * Pushes an active contract's end_date forward by a small number of days
 * (lifetime cap: 60 days) instead of running a full renewal for a short
 * validity gap. Billing already prorates by day and pools any contract by
 * its end_date, so no separate billing step is needed here.
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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const extendAllowedRoles = ["admin", "manager", "sales_rep"];
  if (!extendAllowedRoles.includes(dbUser.role)) {
    return NextResponse.json({
      error: "You do not have permission to extend contracts. Please ask your manager or admin.",
    }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = extendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { days, reason } = parsed.data;

  const { data: contract, error: fetchErr } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (contract.status !== "active") {
    return NextResponse.json({
      error: `Cannot extend a contract with status "${contract.status}". Contract must be active.`,
    }, { status: 400 });
  }

  const oldEndDate = new Date(contract.end_date + "T00:00:00Z");
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  if (today > oldEndDate) {
    return NextResponse.json({
      error: `This contract's validity has already lapsed as of ${contract.end_date}. Use Renewal instead to bring it current.`,
    }, { status: 400 });
  }

  const daysExtended = contract.days_extended || 0;
  const remaining = MAX_LIFETIME_EXTENSION_DAYS - daysExtended;
  if (days > remaining) {
    return NextResponse.json({
      error: remaining <= 0
        ? "This contract has already used its full 60-day extension allowance. Use Renewal instead."
        : `Only ${remaining} more day${remaining === 1 ? "" : "s"} can be extended on this contract (${daysExtended}/${MAX_LIFETIME_EXTENSION_DAYS} days already used).`,
    }, { status: 400 });
  }

  const newEndDate = new Date(oldEndDate);
  newEndDate.setUTCDate(newEndDate.getUTCDate() + days);
  const newEndDateStr = newEndDate.toISOString().slice(0, 10);
  const newDaysExtended = daysExtended + days;

  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({ end_date: newEndDateStr, days_extended: newDaysExtended })
    .eq("id", id)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "contract_extended",
    performedBy: dbUser.id,
    changes: {
      end_date: { old: contract.end_date, new: newEndDateStr },
      days_extended: { old: daysExtended, new: newDaysExtended },
      days_added: { old: null, new: days },
      reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: updated });
}
