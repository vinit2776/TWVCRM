import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { CHARGE_CATEGORIES, billMonthOf, checkLinkInput, lineAmount } from "@/lib/electricity-link";
import { rememberConnectionName } from "@/lib/electricity-bill-context-server";

const LINK_ROLES = ["admin", "manager", "accounts", "office_admin"];

// Same shape check the vendor-bill form uses: tolerant of hand-seeded staging ids.
const idShaped = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const num = z.number().finite();

const schema = z.object({
  vendor_bill_id: idShaped,
  location_id: idShaped,
  connection_id: idShaped.nullish(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  opening_reading: num.nullish(),
  closing_reading: num.nullish(),
  max_demand_kva: num.nullish(),
  billed_pf: num.nullish(),
  consumer_number: z.string().trim().max(60).nullish(),
  printed_name: z.string().trim().max(200).nullish(),
  remember_name: z.boolean().default(false),
  lines: z.array(z.object({
    charge_category: z.enum(CHARGE_CATEGORIES),
    meter_label: z.string().trim().max(100).nullish(),
    label: z.string().trim().max(200).nullish(),
    units: num.nullish(),
    rate: num.nullish(),
    amount: num.nullish(),
  })).min(1).max(40),
});

// Stable codes raised by link_vendor_bill_to_electricity → what the person is told.
const CODE_STATUS: Record<string, number> = {
  LINK_BILL_NOT_FOUND: 404,
  LINK_LOCATION_NOT_FOUND: 404,
  LINK_ALREADY_LINKED: 409,
  LINK_ALREADY_CAPTURED: 409,
  LINK_MONTH_TAKEN: 409,
  LINK_PERIOD_OVERLAP: 409,
};

export async function POST(request: Request) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();

  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!LINK_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not allowed to add electricity details to a bill" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  const b = parsed.data;

  // Same arithmetic as the dialog, so a hand-built request gets the same answer. The database
  // function re-checks the invariants under a lock; this is for a clearer message.
  const { data: vb } = await admin.from("vendor_bills").select("total_amount").eq("id", b.vendor_bill_id).maybeSingle();
  if (!vb) return NextResponse.json({ error: "Vendor bill not found" }, { status: 404 });
  const check = checkLinkInput(
    {
      period_start: b.period_start, period_end: b.period_end,
      opening_reading: b.opening_reading ?? null, closing_reading: b.closing_reading ?? null,
      max_demand_kva: b.max_demand_kva ?? null, billed_pf: b.billed_pf ?? null, lines: b.lines,
    },
    Number(vb.total_amount)
  );
  if (check.errors.length > 0) return NextResponse.json({ error: check.errors.join(" "), errors: check.errors }, { status: 422 });

  const { month, year } = billMonthOf(b.period_start, b.period_end);
  const lines = b.lines.map((l) => ({
    charge_category: l.charge_category,
    meter_label: l.meter_label ?? null,
    label: l.label ?? null,
    units: l.units ?? null,
    rate: l.rate ?? null,
    amount: lineAmount(l),
  }));

  const { data: newId, error } = await admin.rpc("link_vendor_bill_to_electricity", {
    p_vendor_bill_id: b.vendor_bill_id,
    p_user_id: dbUser.id,
    p_location_id: b.location_id,
    p_connection_id: b.connection_id ?? null,
    p_bill_month: month,
    p_bill_year: year,
    p_period_start: b.period_start,
    p_period_end: b.period_end,
    p_units_billed: null,
    p_opening: b.opening_reading ?? null,
    p_closing: b.closing_reading ?? null,
    p_max_demand: b.max_demand_kva ?? null,
    p_billed_pf: b.billed_pf ?? null,
    p_consumer_number: b.consumer_number || null,
    p_printed_name: b.printed_name || null,
    p_lines: lines,
  });
  if (error) {
    const code = /LINK_[A-Z_]+/.exec(error.message)?.[0];
    if (code) {
      const text = error.message.replace(/^.*?LINK_[A-Z_]+:\s*/, "");
      return NextResponse.json({ error: text.charAt(0).toUpperCase() + text.slice(1), code }, { status: CODE_STATUS[code] ?? 422 });
    }
    console.error("link_vendor_bill_to_electricity failed:", error.message);
    return NextResponse.json({ error: "Could not add the electricity details." }, { status: 500 });
  }

  const warnings = [...check.warnings];
  if (b.remember_name && b.printed_name && b.connection_id) {
    const r = await rememberConnectionName(admin, { connectionId: b.connection_id, name: b.printed_name, userId: dbUser.id, billId: b.vendor_bill_id });
    if (r.warning) warnings.push(r.warning);
  }

  await logAudit(admin, {
    entityType: "electricity_bill",
    entityId: newId as string,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      source_vendor_bill_id: { old: null, new: b.vendor_bill_id },
      location_id: { old: null, new: b.location_id },
      connection_id: { old: null, new: b.connection_id ?? null },
      bill_month: { old: null, new: month },
      bill_year: { old: null, new: year },
    },
  });

  return NextResponse.json({ data: { id: newId, bill_month: month, bill_year: year }, warnings }, { status: 201 });
}
