import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";

const serviceSchema = z.object({
  service_name: z.enum(["electricity", "water", "cam", "security", "parking", "wifi", "generator", "hvac", "housekeeping", "other"]),
  custom_service_name: z.string().nullish(),
  landlord_provided: z.boolean().default(false),
  responsible: z.string().nullish(),
  accountable: z.string().nullish(),
  consulted: z.string().nullish(),
  informed: z.string().nullish(),
  frequency: z.enum(["daily", "weekly", "monthly", "on_demand", "as_needed"]).nullish(),
  sla_notes: z.string().nullish(),
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
    .from("lease_service_offerings")
    .select("*")
    .eq("lease_id", id)
    .order("service_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = serviceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("lease_service_offerings")
    .insert({ lease_id: id, ...parsed.data })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_service_offering", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const { service_id, ...rest } = body;
  if (!service_id) return NextResponse.json({ error: "service_id required" }, { status: 400 });

  const parsed = serviceSchema.partial().safeParse(rest);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("lease_service_offerings")
    .update(parsed.data)
    .eq("id", service_id)
    .eq("lease_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "lease_service_offering", entityId: service_id, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}
