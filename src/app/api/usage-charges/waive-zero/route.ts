import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/usage-charges/waive-zero
 *
 * One-click cleanup for the "Usage gap" queue's ₹0 rows (see waiveTarget in
 * unbilled-queue.ts): flips every PENDING, zero-total ad-hoc usage_charge
 * for one contract+month to status="waived", the same end state
 * usage-charges/route.ts now gives a complimentary charge at creation time.
 * There's nothing to bill on these — this just stops them sitting at
 * "pending" forever — so it applies to every match in the window rather
 * than taking a single charge id.
 *
 * Body: { contract_id: string, month: number, year: number }
 * Requires: admin or manager — same gate PATCH /api/usage-charges/[id]
 * uses for status="waived".
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
  const { contract_id, month, year } = body as { contract_id?: string; month?: number; year?: number };

  if (!contract_id || !month || !year) {
    return NextResponse.json({ error: "contract_id, month, and year are required" }, { status: 400 });
  }

  const firstOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

  // Re-verify against the live rows rather than trusting the queue's
  // snapshot — only a still-pending, still-zero, still-unlinked charge in
  // this exact window gets touched.
  const { data: matches, error: fetchError } = await supabase
    .from("usage_charges")
    .select("id")
    .eq("contract_id", contract_id)
    .eq("status", "pending")
    .eq("total", 0)
    .is("billing_statement_id", null)
    .gte("charge_date", firstOfMonth)
    .lte("charge_date", lastOfMonth);

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "Nothing left to waive — it may have already been billed or waived" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("usage_charges")
    .update({
      status: "waived",
      waived_by: dbUser.id,
      waived_at: now,
      waive_reason: "Complimentary charge — waived via Unbilled queue",
    })
    .in("id", matches.map((m) => m.id));

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  for (const m of matches) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: m.id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "pending", new: "waived" }, reason: { old: null, new: "Complimentary charge — waived via Unbilled queue" } },
    });
  }

  return NextResponse.json({ waived: matches.length });
}
