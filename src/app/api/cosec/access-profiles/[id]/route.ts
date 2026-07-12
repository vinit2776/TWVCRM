/**
 * PATCH  /api/cosec/access-profiles/[id]  — update a profile
 * DELETE /api/cosec/access-profiles/[id]  — delete (blocked if in use)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const patchSchema = z.object({
  name:              z.string().min(1).max(80).optional(),
  description:       z.string().nullable().optional(),
  allowed_days:      z.array(z.number().int().min(0).max(6)).min(1).optional(),
  from_time:         z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  until_time:        z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  cosec_user_group:  z.number().int().min(0).max(999).optional(),
  is_default:        z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employee_access_profiles")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Block delete if any active enrollments reference this profile
  const { count } = await admin
    .from("cosec_access_users")
    .select("id", { count: "exact", head: true })
    .eq("access_profile_id", id)
    .neq("enrollment_status", "deleted");

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `Profile is assigned to ${count} active enrollment(s). Reassign them first.` },
      { status: 409 }
    );
  }

  const { error } = await admin.from("employee_access_profiles").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
