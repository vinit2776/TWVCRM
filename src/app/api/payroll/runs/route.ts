import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generatePayrollRun } from "@/lib/payroll";
import { z } from "zod";

const generateSchema = z.object({
  year:  z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12), // 1-indexed from client
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("payroll_runs")
    .select("*, finalizer:users!payroll_runs_finalized_by_fkey(id, full_name)")
    .order("run_month", { ascending: false });

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

  const parsed = generateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  // Convert to 0-indexed month for the engine
  const result = await generatePayrollRun(admin, parsed.data.year, parsed.data.month - 1);

  logAudit(admin, {
    entityType: "payroll_run",
    entityId: result.run_id,
    action: "create",
    performedBy: user.id,
    changes: {
      run_month: { old: null, new: result.run_month },
      employee_count: { old: null, new: result.employee_count },
    },
  });

  return NextResponse.json({ data: result }, { status: 201 });
}
