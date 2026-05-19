import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchSchema = z.object({
  is_verified: z.boolean().optional(),
  is_primary: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; accountId: string }> }
) {
  const { id, accountId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // If setting as primary, unset existing primary first
  if (parsed.data.is_primary) {
    await supabase
      .from("landlord_bank_accounts")
      .update({ is_primary: false })
      .eq("landlord_id", id);
  }

  const { data, error } = await supabase
    .from("landlord_bank_accounts")
    .update(parsed.data)
    .eq("id", accountId)
    .eq("landlord_id", id) // scope to this landlord
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "landlord",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(
      Object.entries(parsed.data).map(([k, v]) => [k, { old: null, new: v }])
    ),
  });

  return NextResponse.json({ data });
}
