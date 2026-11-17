import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_SOURCES } from "@/lib/constants";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a yyyy-MM-dd date");

const createSchema = z
  .object({
    name: z.string().trim().min(2, "Give the promotion a name").max(120),
    source: z.enum(LEAD_SOURCES).nullable().optional(),
    starts_on: day,
    ends_on: day.nullable().optional(),
    spend: z.number().min(0).max(100_000_000).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((d) => !d.ends_on || d.ends_on >= d.starts_on, { message: "It cannot end before it starts", path: ["ends_on"] });

async function whoAmI() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, me: null as null | { id: string; role: string } };
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return { supabase, me: me as null | { id: string; role: string } };
}

// GET /api/leads/promotions?from=yyyy-MM-dd&to=yyyy-MM-dd: promotions running at any time in the range.
export async function GET(request: NextRequest) {
  const { supabase, me } = await whoAmI();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!day.safeParse(from).success || !day.safeParse(to).success || from > to) {
    return NextResponse.json({ error: "from and to must be yyyy-MM-dd days, from not after to" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("lead_promotions")
    .select("id, name, source, starts_on, ends_on, spend, notes")
    .lte("starts_on", to)
    .or(`ends_on.is.null,ends_on.gte.${from}`)
    .order("starts_on", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

// POST /api/leads/promotions: record a promotion. Admin or manager.
export async function POST(request: NextRequest) {
  const { supabase, me } = await whoAmI();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(me.role)) return NextResponse.json({ error: "Only admin or manager can record a promotion" }, { status: 403 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Validation failed", details: parsed.error.issues }, { status: 400 });

  const { data, error } = await createAdminClient()
    .from("lead_promotions")
    .insert({ ...parsed.data, source: parsed.data.source ?? null, ends_on: parsed.data.ends_on ?? null, spend: parsed.data.spend ?? null, notes: parsed.data.notes ?? null, created_by: me.id })
    .select("id, name")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, { entityType: "lead_promotion", entityId: data.id, action: "create", performedBy: me.id, changes: { name: { old: null, new: data.name } } });
  return NextResponse.json({ data }, { status: 201 });
}

// DELETE /api/leads/promotions?id=<uuid>: remove one recorded by mistake. Admin or manager.
export async function DELETE(request: NextRequest) {
  const { supabase, me } = await whoAmI();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(me.role)) return NextResponse.json({ error: "Only admin or manager can remove a promotion" }, { status: 403 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id must be a promotion id" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin.from("lead_promotions").select("id, name").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Promotion not found" }, { status: 404 });
  const { error } = await admin.from("lead_promotions").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, { entityType: "lead_promotion", entityId: id, action: "delete", performedBy: me.id, changes: { name: { old: row.name, new: null } } });
  return NextResponse.json({ ok: true });
}
