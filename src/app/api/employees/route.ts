import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { uuidToRefId } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createSchema = z.object({
  full_name:   z.string().min(1),
  phone:       z.string().nullable().optional(),
  email:       z.string().email().nullable().optional(),
  department:  z.string().nullable().optional(),
  designation: z.string().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("employees")
    .select("*, location:locations(id, name)")
    .order("full_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: currentUser } = await admin
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || !["admin", "manager", "office_admin", "floor_manager"].includes(currentUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data: emp, error } = await admin
    .from("employees")
    .insert(parsed.data)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Deterministic cosec_ref_id in the 50001–89999 range (matches sequence intent)
  const cosecRefId = uuidToRefId(emp.id, 50001, 89999);
  await admin.from("employees").update({ cosec_ref_id: cosecRefId }).eq("id", emp.id);

  logAudit(admin, {
    entityType: "employee",
    entityId: emp.id,
    action: "create",
    performedBy: user.id,
    changes: { created: { old: null, new: emp.full_name } },
  });

  return NextResponse.json({ ...emp, cosec_ref_id: cosecRefId }, { status: 201 });
}
