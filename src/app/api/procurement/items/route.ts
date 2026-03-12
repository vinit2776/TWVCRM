import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createItemSchema = z.object({
  name: z.string().min(1, "Item name is required"),
  department: z.enum(["pantry", "maintenance", "administration"]),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year"]),
  item_type: z.enum(["goods", "service"]).default("goods"),
  standard_price: z.number().min(0).optional(),
  description: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const department = searchParams.get("department");
  const search = searchParams.get("search");
  const itemType = searchParams.get("item_type");
  const includeInactive = searchParams.get("include_inactive") === "true";

  let query = supabase
    .from("procurement_items")
    .select("*", { count: "exact" })
    .order("department")
    .order("name");

  if (!includeInactive) query = query.eq("is_active", true);
  if (department) query = query.eq("department", department);
  if (itemType) query = query.eq("item_type", itemType);
  if (search?.trim()) query = query.ilike("name", `%${search.trim()}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data, count });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only admin can manage the item catalog
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can manage the item catalog" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data: item, error } = await supabase
    .from("procurement_items")
    .insert({ ...parsed.data, created_by: dbUser.id })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "procurement_item",
    entityId: item.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: item }, { status: 201 });
}
