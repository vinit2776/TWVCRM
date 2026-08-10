import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const assetRowSchema = z.object({
  asset_name: z.string().min(1),
  asset_category: z.enum(["civil", "electrical", "furniture", "equipment", "it", "fitting", "other"]).nullish(),
  quantity: z.number().int().positive().default(1),
  condition_at_takeover: z.enum(["excellent", "good", "fair", "poor"]).nullish(),
  notes: z.string().nullish(),
});

const bulkSchema = z.object({
  assets: z.array(assetRowSchema).min(1).max(500),
  mode: z.enum(["append", "replace"]).default("append"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { assets, mode } = parsed.data;

  // Replace mode: delete existing first
  if (mode === "replace") {
    const { error: delErr } = await supabase
      .from("lease_assets")
      .delete()
      .eq("lease_id", id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  const rows = assets.map((a) => ({ lease_id: id, ...a }));
  const { data, error } = await supabase
    .from("lease_assets")
    .insert(rows)
    .select();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "lease_asset",
    entityId: id,
    action: "create",
    performedBy: dbUser.id,
    changes: { bulk_imported: { old: null, new: `${data.length} assets (mode: ${mode})` } },
  });

  return NextResponse.json({ data, count: data.length }, { status: 201 });
}
