import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { VO_RATE_PURPOSES, VO_RATE_TERM_OPTIONS } from "@/lib/constants";
import { isMissingTable, RATES_NOT_SET_UP } from "@/lib/vo-rates-db";

const READ_ROLES = ["admin", "manager", "sales_rep"];
const WRITE_ROLES = ["admin", "manager"];

async function authenticate() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, me: null as null, unauthorized: true };
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return { supabase, me, unauthorized: false };
}

// GET /api/admin/vo-rates: current direct-customer VO rates (?history=1 for every version).
export async function GET(request: NextRequest) {
  const { supabase, me, unauthorized } = await authenticate();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || !READ_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const history = request.nextUrl.searchParams.get("history") === "1";
  let query = supabase
    .from("vo_direct_rates")
    .select("id, purpose, location_id, guide_fee, floor_fee, default_term_months, version, effective_from, effective_until, is_current, reason, created_at, created_by")
    .order("purpose")
    .order("version", { ascending: false });
  if (!history) query = query.eq("is_current", true);

  const { data, error } = await query;
  if (isMissingTable(error)) return NextResponse.json({ data: [], setup: false, message: RATES_NOT_SET_UP });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [], setup: true });
}

const postSchema = z
  .object({
    purpose: z.enum(VO_RATE_PURPOSES),
    // guid, not uuid: the Default Center id (00000000-...-000000000001) has no RFC version digit.
    location_id: z.guid("Invalid location ID").nullable(),
    guide_fee: z.number().min(0).max(100_000_000),
    floor_fee: z.number().min(0).max(100_000_000).nullable(),
    default_term_months: z.number().refine((n) => (VO_RATE_TERM_OPTIONS as readonly number[]).includes(n), "Unsupported term"),
    reason: z.string().trim().max(500).optional(),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.floor_fee === null || v.floor_fee <= v.guide_fee, {
    message: "Floor cannot be above the guide price",
    path: ["floor_fee"],
  });

// POST /api/admin/vo-rates: admin or manager saves a new version of a rate.
export async function POST(request: NextRequest) {
  const { supabase, me, unauthorized } = await authenticate();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || !WRITE_ROLES.includes(me.role)) {
    return NextResponse.json({ error: "Only admin or manager can change the rate card" }, { status: 403 });
  }

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const v = parsed.data;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("vo_direct_rate_new_version", {
    p_purpose: v.purpose,
    p_location_id: v.location_id,
    p_guide_fee: v.guide_fee,
    p_floor_fee: v.floor_fee,
    p_default_term_months: v.default_term_months,
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
    entityType: "vo_direct_rate",
    entityId: row.id,
    action: row.version > 1 ? "update" : "create",
    performedBy: me.id,
    changes: {
      purpose: { old: null, new: v.purpose },
      location_id: { old: null, new: v.location_id },
      guide_fee: { old: null, new: v.guide_fee },
      floor_fee: { old: null, new: v.floor_fee },
      default_term_months: { old: null, new: v.default_term_months },
      version: { old: row.version - 1, new: row.version },
      reason: { old: null, new: v.reason ?? null },
    },
  });
  return NextResponse.json({ data: row }, { status: 201 });
}
