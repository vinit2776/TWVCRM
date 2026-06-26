import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { STOCK_DEPARTMENTS } from "@/lib/constants";
import { z } from "zod";

const createConsumptionSchema = z.object({
  location_id: z.string().uuid(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        item_id: z.string().uuid().optional(),
        item_name: z.string().min(1),
        unit: z.string().min(1),
        quantity_consumed: z.number().positive(),
        notes: z.string().optional(),
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
  const fromDate = searchParams.get("from_date");
  const toDate = searchParams.get("to_date");
  const status = searchParams.get("status");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  let query = supabase
    .from("consumption_logs")
    .select(
      `*, locations(id, name), logger:users!consumption_logs_logged_by_fkey(id, full_name), consumption_log_items(*), consumption_corrections!consumption_corrections_consumption_log_id_fkey(*, corrector:users!consumption_corrections_corrected_by_fkey(id, full_name))`,
      { count: "exact" }
    )
    .order("logged_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (locationId) query = query.eq("location_id", locationId);
  if (fromDate) query = query.gte("logged_at", fromDate);
  if (toDate) query = query.lte("logged_at", toDate);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const parsed = createConsumptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Block non-stock items: services (AMC, rentals, pest control) and items from
  // non-stock departments (e.g. Administration) cannot be consumed.
  const consumeItemIds = parsed.data.items.map((i) => i.item_id).filter(Boolean) as string[];
  if (consumeItemIds.length > 0) {
    const { data: itemRows } = await supabase
      .from("procurement_items")
      .select("id, name, item_type, department")
      .in("id", consumeItemIds);
    const blocked = (itemRows ?? []).find(
      (r) => r.item_type === "service" || !STOCK_DEPARTMENTS.includes(r.department)
    );
    if (blocked) {
      return NextResponse.json(
        { error: `"${blocked.name}" is not a consumable stock item (services and non-stock departments like Administration cannot be consumed).` },
        { status: 422 }
      );
    }
  }

  // Check stock levels — log warnings if below tracked stock, but don't block
  // (physical stock may differ from system records if deliveries weren't location-linked)
  const stockWarnings: string[] = [];
  const itemIdsToCheck = parsed.data.items.map((i) => i.item_id).filter(Boolean) as string[];
  if (itemIdsToCheck.length > 0) {
    const { data: stockRows } = await supabase
      .from("location_stock")
      .select("item_id, quantity_on_hand")
      .eq("location_id", parsed.data.location_id)
      .in("item_id", itemIdsToCheck);
    const stockMap = new Map((stockRows ?? []).map((r) => [r.item_id as string, r.quantity_on_hand]));
    for (const item of parsed.data.items) {
      if (!item.item_id) continue;
      const onHand = stockMap.get(item.item_id) ?? 0;
      if (item.quantity_consumed > Number(onHand)) {
        stockWarnings.push(`${item.item_name}: consumed ${item.quantity_consumed} but system shows ${onHand} in stock`);
      }
    }
  }

  // Insert consumption log header
  const { data: log, error: logError } = await supabase
    .from("consumption_logs")
    .insert({
      location_id: parsed.data.location_id,
      notes: parsed.data.notes ?? null,
      logged_by: dbUser.id,
      status: "active",
    })
    .select("id")
    .single();

  if (logError) return NextResponse.json({ error: logError.message }, { status: 500 });

  // Insert consumption log items
  const items = parsed.data.items.map((item) => ({
    consumption_log_id: log.id,
    item_id: item.item_id ?? null,
    item_name: item.item_name,
    unit: item.unit,
    quantity_consumed: item.quantity_consumed,
    notes: item.notes ?? null,
  }));

  const { error: itemsError } = await supabase.from("consumption_log_items").insert(items);
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  // Deduct stock for each item — run in parallel to avoid N sequential round-trips
  await Promise.all(
    parsed.data.items
      .filter((item) => item.item_id)
      .map(async (item) => {
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: parsed.data.location_id,
          p_item_id: item.item_id,
          p_quantity_delta: -item.quantity_consumed,
        });
        if (rpcError) {
          console.error(`Failed to deduct stock for ${item.item_name}:`, rpcError.message);
        }
      })
  );

  // Check reorder levels at this location
  const { data: reorderAlerts } = await supabase
    .from("location_stock")
    .select("*, procurement_items(id, name, unit)")
    .eq("location_id", parsed.data.location_id)
    .gt("reorder_level", 0)
    .filter("quantity_on_hand", "lte", "reorder_level");

  // If PostgREST column-to-column filter doesn't work, filter in JS
  let alertItems = reorderAlerts ?? [];
  alertItems = alertItems.filter(
    (row: Record<string, unknown>) =>
      Number(row.reorder_level) > 0 &&
      Number(row.quantity_on_hand) <= Number(row.reorder_level)
  );

  await logAudit(supabase, {
    entityType: "consumption_log",
    entityId: log.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      location_id: { old: null, new: parsed.data.location_id },
      item_count: { old: null, new: parsed.data.items.length },
    },
  });

  return NextResponse.json({
    data: log,
    reorder_alerts: alertItems,
    stock_warnings: stockWarnings,
  }, { status: 201 });
}
