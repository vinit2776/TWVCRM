import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * Finance write-off review queue for reversed PO advances (migration 00517).
 *
 * A "written_off" advance reversal (src/app/api/procurement/orders/[id]/route.ts,
 * action: "reverse_advance") is the only reversal mode with real P&L impact and
 * no corroborating money movement (unlike refund_received / adjusted), so it
 * requires a second pair of eyes before it's considered closed. This route lists
 * the queue and lets admin/accounts mark one reviewed — never the same person
 * who recorded the write-off in the first place.
 */

const reviewSchema = z.object({
  action: z.literal("review_advance_writeoff"),
  po_id: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const reviewedParam = searchParams.get("reviewed") ?? "false";
  if (!["false", "all"].includes(reviewedParam)) {
    return NextResponse.json({ error: "reviewed must be 'false' or 'all'" }, { status: 400 });
  }

  // Current financial year (April start) — same convention used in
  // src/app/api/procurement/requests/[id]/route.ts budget checks.
  const now = new Date();
  const currentFY = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fyStart = new Date(currentFY, 3, 1).toISOString();
  const fyEnd = new Date(currentFY + 1, 2, 31, 23, 59, 59).toISOString();

  let query = supabase
    .from("purchase_orders")
    .select(
      `id, po_number, advance_amount, advance_payment_date, advance_payment_mode,
       advance_reversed_at, advance_reversed_by, advance_reversal_reason,
       advance_writeoff_reviewed_at, advance_writeoff_reviewed_by,
       reverser:users!advance_reversed_by(id, full_name, email),
       reviewer:users!advance_writeoff_reviewed_by(id, full_name, email),
       procurement_vendors(id, name)`
    )
    .eq("advance_reversal_mode", "written_off")
    .gte("advance_reversed_at", fyStart)
    .lte("advance_reversed_at", fyEnd)
    .order("advance_reversed_at", { ascending: false });

  if (reviewedParam === "false") {
    query = query.is("advance_writeoff_reviewed_at", null);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data ?? []).map((po) => ({
    po_id: po.id,
    po_number: po.po_number,
    vendor: po.procurement_vendors ?? null,
    advance_amount: po.advance_amount,
    advance_payment_date: po.advance_payment_date,
    advance_payment_mode: po.advance_payment_mode,
    reversed_at: po.advance_reversed_at,
    reversed_by: po.reverser ?? null,
    reversal_reason: po.advance_reversal_reason,
    reviewed_at: po.advance_writeoff_reviewed_at,
    reviewed_by: po.reviewer ?? null,
  }));

  return NextResponse.json({ data: items, financial_year: currentFY });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or accounts can review a write-off" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { po_id } = parsed.data;

  const { data: po, error: fetchError } = await supabase
    .from("purchase_orders")
    .select("id, po_number, advance_reversal_mode, advance_reversed_by, advance_writeoff_reviewed_at")
    .eq("id", po_id)
    .single();
  if (fetchError || !po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });

  if (po.advance_reversal_mode !== "written_off") {
    return NextResponse.json({ error: "This PO's advance was not reversed as a write-off" }, { status: 422 });
  }
  if (po.advance_writeoff_reviewed_at) {
    return NextResponse.json({ error: "This write-off has already been reviewed" }, { status: 422 });
  }
  // The reviewer must not be the person who wrote it off — self-review
  // defeats the whole point of the second-pair-of-eyes control.
  if (dbUser.id === po.advance_reversed_by) {
    return NextResponse.json(
      { error: "You recorded this write-off — a different admin or accounts user must review it" },
      { status: 403 }
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_orders")
    .update({
      advance_writeoff_reviewed_at: new Date().toISOString(),
      advance_writeoff_reviewed_by: dbUser.id,
    })
    .eq("id", po_id)
    .select("*")
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: po_id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      advance_writeoff_reviewed: { old: null, new: true },
    },
  });

  return NextResponse.json({ data: updated });
}
