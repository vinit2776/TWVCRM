import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const lineSchema = z.object({
  line_type: z.enum(["utility", "generator", "other"]),
  meter_label: z.string().nullish(),
  label: z.string().nullish(),
  units: z.number().min(0).nullish(),
  rate: z.number().min(0).nullish(),
  // 'other' lines carry a fixed amount instead of units×rate
  amount: z.number().min(0).nullish(),
  sort_order: z.number().int().default(0),
}).refine(
  (l) => {
    if (l.line_type === "other") return (l.amount ?? 0) > 0;
    return (l.units ?? 0) > 0 && (l.rate ?? 0) > 0;
  },
  { message: "utility/generator lines require units + rate; other lines require amount" },
);

// location_id/bill_month/bill_year are intentionally NOT editable — changing
// them would effectively make this a different bill and could collide with
// the capture route's duplicate-bill guard and the customer-bill period math.
const updateSchema = z.object({
  landlord_bill_number: z.string().nullish(),
  landlord_bill_date: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(lineSchema).min(1, "At least one line is required"),
  landlord_gst_applicable: z.boolean().default(false),
  landlord_gst_rate: z.number().min(0).nullish(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * PATCH /api/electricity-bills/[id]
 *
 * Edit a landlord bill — only while it's still "draft". Once Approve &
 * Generate runs, the customer bill is computed directly from these numbers
 * and becomes the source of truth, so editing after that would silently
 * desync the two; the UI hides the Edit action past that point and
 * handleApprove() warns before locking it in.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: bill, error: billErr } = await supabase
    .from("electricity_bills")
    .select("id, bill_side, status, vendor_bill_id, landlord_total_amount, landlord_gst_amount")
    .eq("id", id)
    .single();

  if (billErr || !bill) {
    return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  }
  if (bill.bill_side !== "landlord") {
    return NextResponse.json({ error: "Only landlord bills can be edited here" }, { status: 422 });
  }
  if (bill.status !== "draft") {
    return NextResponse.json(
      { error: `Bill is already ${bill.status} — only draft bills can be edited. Once approved, use Revise instead.` },
      { status: 422 },
    );
  }

  // Guard the linked vendor bill (if one exists) — if Accounts Payable has
  // already approved or paid against it, that number is no longer safe to
  // silently rewrite.
  let vendorBillId: string | null = null;
  if (bill.vendor_bill_id) {
    const { data: vb } = await supabase
      .from("vendor_bills")
      .select("id, approval_status, amount_paid")
      .eq("id", bill.vendor_bill_id)
      .single();

    if (vb && (vb.approval_status !== "pending" || Number(vb.amount_paid ?? 0) > 0)) {
      return NextResponse.json(
        {
          error:
            "Cannot edit — the linked vendor bill has already been approved or has payments recorded. " +
            "Adjust it directly under Finance → Acc Payables instead.",
        },
        { status: 422 },
      );
    }
    vendorBillId = bill.vendor_bill_id;
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { landlord_bill_number, landlord_bill_date, notes, lines, landlord_gst_applicable, landlord_gst_rate } = parsed.data;

  const landlordTotal = lines.reduce((s, l) => {
    if (l.line_type === "other") return s + (l.amount ?? 0);
    return s + (l.units ?? 0) * (l.rate ?? 0);
  }, 0);
  const landlordGstAmount = landlord_gst_applicable
    ? round2(landlordTotal * (Number(landlord_gst_rate ?? 0) / 100))
    : 0;

  // electricity_bills has no "notes" column — the capture route only ever
  // passes notes through to the auto-created vendor bill, never onto the
  // landlord bill row itself. Mirrored below when syncing the vendor bill.
  const { error: updateErr } = await supabase
    .from("electricity_bills")
    .update({
      landlord_bill_number: landlord_bill_number ?? null,
      landlord_bill_date: landlord_bill_date ?? null,
      landlord_total_amount: landlordTotal,
      landlord_gst_applicable,
      landlord_gst_rate: landlord_gst_applicable ? (landlord_gst_rate ?? 18) : null,
      landlord_gst_amount: landlordGstAmount,
    })
    .eq("id", id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  // Replace-all on lines — there's no per-line update path today either, so
  // this matches the granularity the capture route already works at.
  const { error: deleteLinesErr } = await supabase
    .from("electricity_bill_lines")
    .delete()
    .eq("electricity_bill_id", id);
  if (deleteLinesErr) return NextResponse.json({ error: deleteLinesErr.message }, { status: 500 });

  const lineInserts = lines.map((l, i) => ({
    electricity_bill_id: id,
    line_type: l.line_type,
    meter_label: l.meter_label ?? null,
    label: l.label ?? null,
    units: l.line_type !== "other" ? (l.units ?? null) : null,
    rate: l.line_type !== "other" ? (l.rate ?? null) : null,
    amount: l.line_type === "other" ? (l.amount ?? 0) : (l.units ?? 0) * (l.rate ?? 0),
    sort_order: l.sort_order ?? i,
  }));
  const { error: insertLinesErr } = await supabase
    .from("electricity_bill_lines")
    .insert(lineInserts);
  if (insertLinesErr) return NextResponse.json({ error: insertLinesErr.message }, { status: 500 });

  // Keep the auto-created vendor bill (if any, and if it passed the guard
  // above) in sync — otherwise the Inward card would show a stale payable.
  if (vendorBillId) {
    const { error: vbUpdateErr } = await supabase
      .from("vendor_bills")
      .update({
        total_amount: landlordTotal,
        gst_amount: landlordGstAmount,
        base_amount: landlordTotal,
        notes: notes ?? null,
      })
      .eq("id", vendorBillId);
    if (vbUpdateErr) {
      return NextResponse.json(
        { error: `Bill updated, but failed to sync the linked vendor bill: ${vbUpdateErr.message}` },
        { status: 500 },
      );
    }
  }

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      landlord_total: { old: bill.landlord_total_amount, new: landlordTotal },
      landlord_gst_amount: { old: bill.landlord_gst_amount, new: landlordGstAmount },
    },
  });

  return NextResponse.json({ data: { id, landlord_total_amount: landlordTotal } });
}
