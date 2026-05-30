import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const addonSchema = z.object({
  description: z.string().min(1).max(200),
  amount: z.number().positive(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_addons")
    .select("*")
    .eq("contract_id", id)
    .order("effective_from", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const result = addonSchema.safeParse(body);
  if (!result.success) return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const adminSupabase = createAdminClient();
  const { data, error } = await adminSupabase
    .from("contract_addons")
    .insert({
      contract_id: id,
      description: result.data.description,
      amount: result.data.amount,
      effective_from: result.data.effective_from,
      effective_until: result.data.effective_until ?? null,
      is_active: result.data.is_active,
      created_by: dbUser?.id ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser?.id ?? "",
    changes: { addon_added: { old: null, new: result.data.description } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { addon_id, ...fields } = body;
  if (!addon_id) return NextResponse.json({ error: "addon_id required" }, { status: 400 });

  const allowed: Record<string, unknown> = {};
  if (fields.description !== undefined) allowed.description = fields.description;
  if (fields.amount !== undefined) allowed.amount = fields.amount;
  if (fields.effective_from !== undefined) allowed.effective_from = fields.effective_from;
  if (fields.effective_until !== undefined) allowed.effective_until = fields.effective_until;
  if (fields.is_active !== undefined) allowed.is_active = fields.is_active;
  allowed.updated_at = new Date().toISOString();

  const adminSupabase = createAdminClient();
  const { data, error } = await adminSupabase
    .from("contract_addons")
    .update(allowed)
    .eq("id", addon_id)
    .eq("contract_id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
