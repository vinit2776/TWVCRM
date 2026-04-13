import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  department: z.enum(["pantry", "maintenance", "administration", "asset"]).optional(),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year", "nos", "can", "ton"]).optional(),
  item_type: z.enum(["goods", "service"]).optional(),
  standard_price: z.number().min(0).optional().nullable(),
  gst_rate: z.number().min(0).max(28).optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("procurement_items")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // ── Fetch current item (needed for name-uniqueness check + price history) ──
  const { data: current, error: fetchErr } = await supabase
    .from("procurement_items")
    .select("id, name, standard_price")
    .eq("id", id)
    .single();

  if (fetchErr || !current) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  // ── Name uniqueness check (if name is being changed) ────────────────
  if (parsed.data.name && parsed.data.name.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
    const { data: existing } = await supabase
      .from("procurement_items")
      .select("id, name")
      .ilike("name", parsed.data.name.trim())
      .neq("id", id)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: `An item named "${existing.name}" already exists in the catalog. Item names must be unique.` },
        { status: 409 }
      );
    }
  }

  // ── Update item ──────────────────────────────────────────────────────
  const { data: updated, error } = await supabase
    .from("procurement_items")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  // ── Record price history when standard_price changes ────────────────
  const oldPrice = current.standard_price != null ? Number(current.standard_price) : null;
  const newPrice = parsed.data.standard_price != null ? Number(parsed.data.standard_price) : null;

  if (
    "standard_price" in parsed.data &&
    oldPrice !== newPrice
  ) {
    await supabase.from("procurement_item_price_history").insert({
      item_id:    id,
      old_price:  oldPrice,
      new_price:  newPrice,
      changed_by: dbUser.id,
    });
  }

  await logAudit(supabase, {
    entityType: "procurement_item",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: updated });
}
