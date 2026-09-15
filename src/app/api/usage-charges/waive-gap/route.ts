import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/usage-charges/waive-gap
 *
 * One-click waive for an ad-hoc charge stuck in the "Usage gap" queue (see
 * waiveTarget in unbilled-queue.ts): flips every PENDING ad-hoc usage_charge
 * for one contract+month to status="waived" — a complimentary ₹0 entry with
 * nothing to bill, or a real, billable charge someone decides not to
 * collect. Both cases go through the same snapshot-then-zero shape PATCH
 * /api/usage-charges/[id]'s waived branch uses, just batched across every
 * match in the window instead of one charge id.
 *
 * Print/facility usage contributions to the same gap bucket are untouched —
 * neither table has a per-record "waived" status to flip — so a mixed
 * bucket only has its ad-hoc share cleared here; the row still shows the
 * remainder afterward.
 *
 * Body: { contract_id: string, month: number, year: number, reason?: string }
 * `reason` is required when the matched charges are worth more than ₹0 —
 * forgiving real money needs a reason on file, same as the statement-level
 * waive-charge route. A pure ₹0 cleanup defaults to a standard note.
 * Requires: admin or manager — same gate PATCH /api/usage-charges/[id] uses
 * for status="waived".
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin and managers can waive charges" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const { contract_id, month, year, reason } = body as { contract_id?: string; month?: number; year?: number; reason?: string };

  if (!contract_id || !month || !year) {
    return NextResponse.json({ error: "contract_id, month, and year are required" }, { status: 400 });
  }

  const firstOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

  // Re-verify against the live rows rather than trusting the queue's
  // snapshot — only still-pending, still-unlinked ad-hoc charges in this
  // exact window get touched.
  const { data: matches, error: fetchError } = await supabase
    .from("usage_charges")
    .select("id, unit_price, total, gst_amount, total_with_gst")
    .eq("contract_id", contract_id)
    .eq("status", "pending")
    .is("billing_statement_id", null)
    .gte("charge_date", firstOfMonth)
    .lte("charge_date", lastOfMonth);

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "Nothing left to waive — it may have already been billed or waived" }, { status: 404 });
  }

  const waivedAmount = matches.reduce((sum, m) => sum + Number(m.total || 0), 0);
  const trimmedReason = reason?.trim();
  if (waivedAmount > 0 && !trimmedReason) {
    return NextResponse.json({ error: "A reason is required when waiving a billable charge" }, { status: 400 });
  }
  const finalReason = trimmedReason || "Complimentary charge — waived via Unbilled queue";

  const now = new Date().toISOString();
  for (const m of matches) {
    const { error: updateError } = await supabase
      .from("usage_charges")
      .update({
        status: "waived",
        waived_by: dbUser.id,
        waived_at: now,
        waive_reason: finalReason,
        // Snapshot before zeroing — every other writer of status:"waived"
        // in this codebase (free-quota bookings/facilities, this route
        // included) zeroes the amount fields, since the Usage Charges table
        // reads `total` directly without checking status.
        original_unit_price: Number(m.unit_price ?? 0),
        original_total: Number(m.total ?? 0),
        original_gst_amount: Number(m.gst_amount ?? 0),
        original_total_with_gst: Number(m.total_with_gst ?? 0),
        unit_price: 0,
        total: 0,
        gst_amount: 0,
        total_with_gst: 0,
      })
      .eq("id", m.id);

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: m.id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: "pending", new: "waived" },
        total: { old: Number(m.total || 0), new: 0 },
        reason: { old: null, new: finalReason },
      },
    });
  }

  return NextResponse.json({ waived: matches.length, waivedAmount });
}
