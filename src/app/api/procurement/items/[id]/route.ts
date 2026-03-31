import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  department: z.enum(["pantry", "maintenance", "administration"]).optional(),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year"]).optional(),
  item_type: z.enum(["goods", "service"]).optional(),
  standard_price: z.number().min(0).optional().nullable(),
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

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "fms", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins, FMS, and floor managers can manage the item catalog" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("procurement_items")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  await logAudit(supabase, {
    entityType: "procurement_item",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: updated });
}
