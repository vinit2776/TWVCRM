import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — list prepaid package templates
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const workspaceType = searchParams.get("workspace_type");
  const isActive = searchParams.get("is_active");

  let query = supabase
    .from("prepaid_packages")
    .select("*, location:locations(id,name)")
    .order("created_at", { ascending: false });

  if (locationId) query = query.eq("location_id", locationId);
  if (workspaceType) query = query.eq("workspace_type", workspaceType);
  if (isActive !== null) query = query.eq("is_active", isActive === "true");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

// POST — create a new package template
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const {
    name,
    description,
    location_id,
    workspace_type,
    credit_type,
    total_credits,
    price,
    validity_days,
  } = body;

  if (!name || !credit_type || !total_credits || price == null || !validity_days) {
    return NextResponse.json({ error: "name, credit_type, total_credits, price and validity_days are required" }, { status: 400 });
  }

  if (!["hours", "days"].includes(credit_type)) {
    return NextResponse.json({ error: "credit_type must be 'hours' or 'days'" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("prepaid_packages")
    .insert({
      name: name.trim(),
      description: description?.trim() || null,
      location_id: location_id || null,
      workspace_type: workspace_type || null,
      credit_type,
      total_credits: Number(total_credits),
      price: Number(price),
      validity_days: Number(validity_days),
      is_active: true,
      created_by: user.id,
    })
    .select("*, location:locations(id,name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data }, { status: 201 });
}
