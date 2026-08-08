import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const photosSchema = z.object({
  photo_type: z.enum(["before", "after"]),
  urls: z.array(z.string().url()).min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; hId: string }> }
) {
  const { hId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = photosSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data: handover } = await supabase
    .from("lease_asset_handovers")
    .select("before_photos, after_photos")
    .eq("id", hId)
    .single();

  if (!handover) return NextResponse.json({ error: "Handover not found" }, { status: 404 });

  const field = parsed.data.photo_type === "before" ? "before_photos" : "after_photos";
  const existing: string[] = handover[field] || [];
  const merged = [...new Set([...existing, ...parsed.data.urls])];

  const { data, error } = await supabase
    .from("lease_asset_handovers")
    .update({ [field]: merged })
    .eq("id", hId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_handover", entityId: hId, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}
