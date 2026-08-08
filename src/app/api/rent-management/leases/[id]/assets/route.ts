import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { zodErrorResponse } from "@/lib/validations";

const createAssetSchema = z.object({
  asset_name: z.string().min(1),
  asset_category: z.enum(["civil", "electrical", "furniture", "equipment", "it", "fitting", "other"]).nullish(),
  serial_number: z.string().nullish(),
  make_model: z.string().nullish(),
  quantity: z.number().int().positive().default(1),
  unit_value: z.number().min(0).default(0),
  is_capex: z.boolean().default(false),
  condition_at_takeover: z.enum(["excellent", "good", "fair", "poor"]).nullish(),
  notes: z.string().nullish(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("lease_assets")
    .select("*")
    .eq("lease_id", id)
    .order("asset_category", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createAssetSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data, error } = await supabase
    .from("lease_assets")
    .insert({ lease_id: id, ...parsed.data })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_asset", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}
