import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const upsertSchema = z.object({
  employee_id:          z.string().uuid(),
  effective_from:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basic:                z.number().min(0),
  hra:                  z.number().min(0).default(0),
  da:                   z.number().min(0).default(0),
  special_allowance:    z.number().min(0).default(0),
  lta_annual:           z.number().min(0).default(0),
  mobile_reimbursement: z.number().min(0).default(0),
  other_reimbursements: z.number().min(0).default(0),
  tds_applicable:       z.boolean().default(false),
  tds_monthly_amount:   z.number().min(0).default(0),
  pan_number:           z.string().nullable().optional(),
  pf_applicable:        z.boolean().default(false),
  esi_applicable:       z.boolean().default(false),
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("employee_salary_definitions")
    .select("*, employee:employees(id, full_name, department, designation, is_active)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = upsertSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("employee_salary_definitions")
    .upsert({ ...parsed.data, updated_at: now }, { onConflict: "employee_id" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "salary_definition",
    entityId: data.id,
    action: "update",
    performedBy: user.id,
    changes: { salary_definition: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}
