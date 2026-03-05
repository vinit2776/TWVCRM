import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// GET /api/proposal-presets
// Returns all active presets ordered by sort_order, name
// ---------------------------------------------------------------------------
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proposal_line_item_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

// ---------------------------------------------------------------------------
// POST /api/proposal-presets
// Create a new preset
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { name, description, quantity, unit, unit_price, category, sort_order } = body;

  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!description?.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 });
  if (unit_price === undefined || unit_price === null || isNaN(Number(unit_price))) {
    return NextResponse.json({ error: "unit_price is required" }, { status: 400 });
  }

  // Resolve internal user id
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { data, error } = await supabase
    .from("proposal_line_item_presets")
    .insert({
      name:        name.trim(),
      description: description.trim(),
      quantity:    Number(quantity) || 1,
      unit:        unit?.trim() || null,
      unit_price:  Number(unit_price),
      category:    category?.trim() || null,
      sort_order:  Number(sort_order) || 0,
      created_by:  dbUser?.id ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data }, { status: 201 });
}
