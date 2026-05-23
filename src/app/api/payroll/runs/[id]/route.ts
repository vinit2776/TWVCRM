import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchSchema = z.object({
  action: z.enum(["finalize"]),
  notes:  z.string().nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: run, error } = await supabase
    .from("payroll_runs")
    .select("*, finalizer:users!payroll_runs_finalized_by_fkey(id, full_name)")
    .eq("id", id)
    .single();

  if (error || !run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: slips, error: slipErr } = await supabase
    .from("payroll_slips")
    .select("*")
    .eq("payroll_run_id", id)
    .order("employee_name");

  if (slipErr) return NextResponse.json({ error: slipErr.message }, { status: 500 });

  return NextResponse.json({ run, slips });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or accounts can finalize a payroll run" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: run } = await admin
    .from("payroll_runs")
    .select("id, status")
    .eq("id", id)
    .single();

  if (!run) return NextResponse.json({ error: "Payroll run not found" }, { status: 404 });
  if (run.status === "finalized") {
    return NextResponse.json({ error: "Payroll run is already finalized" }, { status: 400 });
  }

  // Lock all slips
  await admin
    .from("payroll_slips")
    .update({ is_locked: true, updated_at: now })
    .eq("payroll_run_id", id);

  // Finalize the run
  const { data: updated, error } = await admin
    .from("payroll_runs")
    .update({
      status: "finalized",
      finalized_by: dbUser.id,
      finalized_at: now,
      notes: parsed.data.notes ?? null,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "payroll_run",
    entityId: id,
    action: "update",
    performedBy: user.id,
    changes: { status: { old: "draft", new: "finalized" } },
  });

  return NextResponse.json({ data: updated });
}
