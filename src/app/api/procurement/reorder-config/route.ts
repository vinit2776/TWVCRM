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
        // Refill target for MOQ replenishment. null = unset (no auto-suggest).
        max_level: z.number().min(0).nullable().optional(),
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

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = bulkUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Upsert each row, updating only the level columns on conflict.
  // quantity_on_hand is intentionally OMITTED so existing stock is preserved
  // (new rows fall back to its DEFAULT 0); the old code clobbered stock to 0.
  const errors: string[] = [];
  for (const item of parsed.data.items) {
    const { error } = await supabase
      .from("location_stock")
      .upsert(
        {
          location_id: parsed.data.location_id,
          item_id: item.item_id,
          reorder_level: item.reorder_level,
          max_level: item.max_level ?? null,
        },
        { onConflict: "location_id,item_id", ignoreDuplicates: false }
      );
    if (error) errors.push(`${item.item_id}: ${error.message}`);
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
        new: parsed.data.items.map((i) => ({ item_id: i.item_id, reorder_level: i.reorder_level, max_level: i.max_level ?? null })),
      },
    },
  });

  return NextResponse.json({ data: { updated: parsed.data.items.length } });
}
