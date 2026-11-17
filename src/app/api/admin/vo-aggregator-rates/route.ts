import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { VO_RATE_PURPOSES } from "@/lib/constants";
import { isMissingTable, RATES_NOT_SET_UP } from "@/lib/vo-rates-db";
import { copyCardRows, validateRowInput } from "@/lib/vo-aggregator-rates";

const READ_ROLES = ["admin", "manager", "sales_rep"];
const WRITE_ROLES = ["admin", "manager"];
const COLUMNS =
  "id, aggregator_id, purpose, location_id, pricing_type, share_percent, min_customer_price, fixed_rate, version, effective_from, effective_until, is_current, reason, created_at";

async function authenticate() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, me: null, unauthorized: true };
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return { supabase, me, unauthorized: false };
}

// GET /api/admin/vo-aggregator-rates?aggregator_id=...&history=1
export async function GET(request: NextRequest) {
  const { supabase, me, unauthorized } = await authenticate();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || !READ_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const aggregatorId = request.nextUrl.searchParams.get("aggregator_id");
  if (!aggregatorId || !z.string().uuid().safeParse(aggregatorId).success) {
    return NextResponse.json({ error: "Validation failed", details: [{ path: ["aggregator_id"], message: "aggregator_id is required" }] }, { status: 400 });
  }
  const history = request.nextUrl.searchParams.get("history") === "1";

  let query = supabase
    .from("vo_aggregator_rates")
    .select(COLUMNS)
    .eq("aggregator_id", aggregatorId)
    .order("purpose")
    .order("version", { ascending: false });
  if (!history) query = query.eq("is_current", true);

  const { data, error } = await query;
  if (isMissingTable(error)) return NextResponse.json({ data: [], setup: false, message: RATES_NOT_SET_UP });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [], setup: true });
}

const money = z.number().min(0).max(100_000_000);
const rowSchema = z.object({
  aggregator_id: z.string().uuid(),
  purpose: z.enum(VO_RATE_PURPOSES),
  location_id: z.guid("Invalid location ID").nullable(),
  pricing_type: z.enum(["open", "fixed"]),
  share_percent: z.number().min(1).max(99).nullable(),
  min_customer_price: money.nullable(),
  fixed_rate: money.nullable(),
  reason: z.string().trim().max(500).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const addCardSchema = z.object({
  action: z.literal("add_card"),
  aggregator_id: z.string().uuid(),
  copy_from_aggregator_id: z.string().uuid().optional(),
});

// POST: a new version of one row, or { action: "add_card" } to start a card (blank or copied).
export async function POST(request: NextRequest) {
  const { supabase, me, unauthorized } = await authenticate();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || !WRITE_ROLES.includes(me.role)) {
    return NextResponse.json({ error: "Only admin or manager can change aggregator rate cards" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const admin = createAdminClient();

  if (body && typeof body === "object" && (body as { action?: unknown }).action === "add_card") {
    const parsed = addCardSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
    const { aggregator_id, copy_from_aggregator_id } = parsed.data;

    const { data: agg } = await admin.from("aggregators").select("id").eq("id", aggregator_id).maybeSingle();
    if (!agg) return NextResponse.json({ error: "Aggregator not found" }, { status: 404 });

    const { data: existing, error: exErr } = await admin
      .from("vo_aggregator_rates").select("id").eq("aggregator_id", aggregator_id).eq("is_current", true).limit(1);
    if (isMissingTable(exErr)) return NextResponse.json({ error: RATES_NOT_SET_UP }, { status: 409 });
    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
    if (existing && existing.length > 0) return NextResponse.json({ error: "This aggregator already has a rate card" }, { status: 409 });

    let created = 0;
    if (copy_from_aggregator_id) {
      if (copy_from_aggregator_id === aggregator_id) return NextResponse.json({ error: "Cannot copy a card onto itself" }, { status: 400 });
      const { data: source, error: srcErr } = await admin
        .from("vo_aggregator_rates").select(COLUMNS).eq("aggregator_id", copy_from_aggregator_id).eq("is_current", true);
      if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
      const today = new Date().toISOString().slice(0, 10);
      for (const r of copyCardRows(source ?? [], { effectiveFrom: today })) {
        const { error } = await admin.rpc("vo_aggregator_rate_new_version", {
          p_aggregator_id: aggregator_id,
          p_purpose: r.purpose,
          p_location_id: r.location_id,
          p_pricing_type: r.pricing_type,
          p_share_percent: r.share_percent,
          p_min_customer_price: r.min_customer_price,
          p_fixed_rate: r.fixed_rate,
          p_reason: null,
          p_effective_from: r.effective_from,
          p_created_by: me.id,
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        created += 1;
      }
    }

    logAudit(supabase, {
      entityType: "vo_aggregator_rate",
      entityId: aggregator_id,
      action: "create",
      performedBy: me.id,
      changes: {
        card: { old: null, new: copy_from_aggregator_id ? `copied from ${copy_from_aggregator_id}` : "blank" },
        rows_created: { old: null, new: created },
      },
    });
    return NextResponse.json({ ok: true, rows_created: created }, { status: 201 });
  }

  const parsed = rowSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const v = parsed.data;
  const problems = validateRowInput(v);
  if (problems.length > 0) {
    return NextResponse.json({ error: "Validation failed", details: problems.map((message) => ({ message })) }, { status: 400 });
  }

  const { data, error } = await admin.rpc("vo_aggregator_rate_new_version", {
    p_aggregator_id: v.aggregator_id,
    p_purpose: v.purpose,
    p_location_id: v.location_id,
    p_pricing_type: v.pricing_type,
    p_share_percent: v.share_percent,
    p_min_customer_price: v.min_customer_price,
    p_fixed_rate: v.fixed_rate,
    p_reason: v.reason ?? null,
    p_effective_from: v.effective_from ?? null,
    p_created_by: me.id,
  });
  if (error) {
    if (isMissingTable(error) || error.code === "42883" || error.code === "PGRST202") {
      return NextResponse.json({ error: RATES_NOT_SET_UP }, { status: 409 });
    }
    if (error.code === "P0001") return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = data as { id: string; version: number };
  logAudit(supabase, {
    entityType: "vo_aggregator_rate",
    entityId: row.id,
    action: row.version > 1 ? "update" : "create",
    performedBy: me.id,
    changes: {
      aggregator_id: { old: null, new: v.aggregator_id },
      purpose: { old: null, new: v.purpose },
      location_id: { old: null, new: v.location_id },
      pricing_type: { old: null, new: v.pricing_type },
      share_percent: { old: null, new: v.share_percent },
      min_customer_price: { old: null, new: v.min_customer_price },
      fixed_rate: { old: null, new: v.fixed_rate },
      version: { old: row.version - 1, new: row.version },
      reason: { old: null, new: v.reason ?? null },
    },
  });
  return NextResponse.json({ data: row }, { status: 201 });
}
