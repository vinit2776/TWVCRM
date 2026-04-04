import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const bulkUpsertSchema = z.object({
  location_id: z.string().uuid(),
  items: z
    .array(
      z.object({
        item_id: z.string().uuid(),
        reorder_level: z.number().min(0),
      })
    )
    .min(1, "At least one item is required"),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");

  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("location_stock")
    .select(`*, procurement_items(id, name, department, unit)`)
    .eq("location_id", locationId)
    .order("name", { referencedTable: "procurement_items", ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can update reorder levels" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = bulkUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const upsertRows = parsed.data.items.map((item) => ({
    location_id: parsed.data.location_id,
    item_id: item.item_id,
    reorder_level: item.reorder_level,
    quantity_on_hand: 0, // default for new rows; existing rows keep their value via ON CONFLICT
  }));

  // Upsert each row individually to only update reorder_level on conflict
  const errors: string[] = [];
  for (const row of upsertRows) {
    const { error } = await supabase
      .from("location_stock")
      .upsert(
        {
          location_id: row.location_id,
          item_id: row.item_id,
          reorder_level: row.reorder_level,
          quantity_on_hand: row.quantity_on_hand,
        },
        { onConflict: "location_id,item_id", ignoreDuplicates: false }
      );
    if (error) errors.push(`${row.item_id}: ${error.message}`);
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "Some items failed to update", details: errors }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "location",
    entityId: parsed.data.location_id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      reorder_levels: {
        old: null,
        new: parsed.data.items.map((i) => ({ item_id: i.item_id, reorder_level: i.reorder_level })),
      },
    },
  });

  return NextResponse.json({ data: { updated: parsed.data.items.length } });
}
