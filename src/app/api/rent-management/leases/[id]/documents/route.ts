import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { zodErrorResponse } from "@/lib/validations";

const createDocSchema = z.object({
  document_type: z.enum(["lease_deed", "floor_plan", "electrical_drawing", "noc", "amendment", "correspondence", "other"]),
  document_name: z.string().min(1),
  file_url: z.string().url(),
  file_size: z.number().int().nullish(),
  mime_type: z.string().nullish(),
  version: z.number().int().min(1).default(1),
  description: z.string().nullish(),
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
    .from("lease_documents")
    .select("*")
    .eq("lease_id", id)
    .order("document_type")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve uploader names
  const userIds = [...new Set((data || []).map((d) => d.uploaded_by).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", userIds);
    for (const u of users || []) nameMap[u.id] = u.full_name;
  }

  const enriched = (data || []).map((d) => ({ ...d, uploaded_by_name: d.uploaded_by ? nameMap[d.uploaded_by] : null }));
  return NextResponse.json({ data: enriched });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createDocSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data, error } = await supabase
    .from("lease_documents")
    .insert({ lease_id: id, uploaded_by: dbUser.id, ...parsed.data })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_document", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}
