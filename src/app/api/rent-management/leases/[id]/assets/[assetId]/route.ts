import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchSchema = z.object({
  asset_name: z.string().min(1).optional(),
  asset_category: z.enum(["civil", "electrical", "furniture", "equipment", "it", "fitting", "other"]).nullish(),
  quantity: z.number().int().positive().optional(),
  condition_at_takeover: z.enum(["excellent", "good", "fair", "poor"]).nullish(),
  notes: z.string().nullish(),
});

type Params = { params: Promise<{ id: string; assetId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id, assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("lease_assets")
    .update(parsed.data)
    .eq("id", assetId)
    .eq("lease_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_asset", entityId: assetId, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id, assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await supabase
    .from("lease_assets")
    .delete()
    .eq("id", assetId)
    .eq("lease_id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_asset", entityId: assetId, action: "delete", performedBy: dbUser.id });
  return NextResponse.json({ success: true });
}
