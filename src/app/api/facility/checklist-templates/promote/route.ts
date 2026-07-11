import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const promoteSchema = z.object({
  label: z.string().min(1).max(300),
  category_id: z.string().uuid(),
  event_type: z.string().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "fms"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = promoteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("facility_checklist_templates")
    .select("id")
    .eq("category_id", parsed.data.category_id)
    .eq("label", parsed.data.label)
    .eq("is_active", true)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "Template item with this label already exists" }, { status: 409 });
  }

  const { data: maxSort } = await admin
    .from("facility_checklist_templates")
    .select("sort_order")
    .eq("category_id", parsed.data.category_id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await admin
    .from("facility_checklist_templates")
    .insert({
      category_id: parsed.data.category_id,
      event_type: parsed.data.event_type || null,
      label: parsed.data.label,
      sort_order: (maxSort?.sort_order ?? 0) + 1,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
