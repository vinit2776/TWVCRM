import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getLastReceivedMap } from "@/lib/procurement/stock-aging";
import { z } from "zod";

const upsertStockSchema = z.object({
  location_id: z.string().uuid(),
  item_id: z.string().uuid(),
  quantity_on_hand: z.number().min(0),
  reorder_level: z.number().min(0).optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const department = searchParams.get("department");
  const belowReorder = searchParams.get("below_reorder");

  let query = supabase
    .from("location_stock")
    .select(
      `*, procurement_items(id, name, department, unit, item_type), locations(id, name, code)`
    )
    .order("name", { referencedTable: "procurement_items", ascending: true });

  if (locationId) query = query.eq("location_id", locationId);
  if (department) query = query.eq("procurement_items.department", department);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let results = data ?? [];

  // Filter below reorder in JS since Supabase doesn't support column-to-column comparison easily
  if (belowReorder === "true") {
    results = results.filter(
      (row: Record<string, unknown>) =>
        Number(row.reorder_level) > 0 &&
        Number(row.quantity_on_hand) <= Number(row.reorder_level)
    );
  }

  // Filter by department in JS if the join-level filter didn't work (PostgREST limitation)
  if (department) {
    results = results.filter(
      (row: Record<string, unknown>) => {
        const item = row.procurement_items as Record<string, unknown> | null;
        return item && item.department === department;
      }
    );
  }

  // Attach stock age: most recent inward (PO delivery / transfer) per item
  if (locationId && results.length > 0) {
    const lastReceivedMap = await getLastReceivedMap(supabase, locationId);
    results = results.map((row: Record<string, unknown>) => ({
      ...row,
      last_received: lastReceivedMap.get(String(row.item_id)) ?? null,
    }));
  }

  return NextResponse.json({ data: results });
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
  const parsed = upsertStockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("location_stock")
    .upsert(
      {
        location_id: parsed.data.location_id,
        item_id: parsed.data.item_id,
        quantity_on_hand: parsed.data.quantity_on_hand,
        reorder_level: parsed.data.reorder_level ?? 0,
      },
      { onConflict: "location_id,item_id" }
    )
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data }, { status: 201 });
}
