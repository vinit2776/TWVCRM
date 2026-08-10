/**
 * GET  /api/cosec/access-profiles  — list all profiles
 * POST /api/cosec/access-profiles  — create a new profile
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const profileSchema = z.object({
  name:              z.string().min(1).max(80),
  description:       z.string().optional(),
  allowed_days:      z.array(z.number().int().min(0).max(6)).min(1),
  from_time:         z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  until_time:        z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  cosec_user_group:  z.number().int().min(0).max(999).default(0),
  is_default:        z.boolean().optional(),
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employee_access_profiles")
    .select("*")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = profileSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employee_access_profiles")
    .insert(parsed.data)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
