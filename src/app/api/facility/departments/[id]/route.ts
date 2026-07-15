import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import { z } from "zod";

const headSchema = z.object({
  head_user_id: z.string().uuid().nullable(),
});

/**
 * PATCH /api/facility/departments/[id]
 * Sets (or clears) a department's head — the user Work Orders in this
 * scope auto-assign to when the category has no more-specific default.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = headSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  if (parsed.data.head_user_id) {
    const adminClient = createAdminClient();
    const { data: head } = await adminClient
      .from("users").select("id, is_active").eq("id", parsed.data.head_user_id).single();
    if (!head?.is_active) {
      return NextResponse.json({ error: "Selected head is not an active user" }, { status: 400 });
    }
  }

  const { data: existing } = await supabase
    .from("facility_departments").select("id, scope, head_user_id").eq("id", id).single();
  if (!existing) return NextResponse.json({ error: "Department not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("facility_departments")
    .update({ head_user_id: parsed.data.head_user_id })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_department",
    entityId: id,
    action: "update",
    performedBy: dbUser!.id,
    changes: { head_user_id: { old: existing.head_user_id, new: parsed.data.head_user_id } },
  });

  return NextResponse.json({ data });
}
