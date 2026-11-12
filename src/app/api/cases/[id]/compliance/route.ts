import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateComplianceCheckSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { advanceCaseStage } from "@/lib/case-status-events";

/**
 * GET: List all compliance checks for a case
 * PATCH: Update a specific compliance check (pass/fail/waive)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("case_compliance_checks")
    .select("*, checker:users!case_compliance_checks_checked_by_fkey(id, full_name, email)")
    .eq("case_id", id)
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Compute summary
  const total = data?.length || 0;
  const passed = data?.filter((c) => c.status === "passed").length || 0;
  const failed = data?.filter((c) => c.status === "failed").length || 0;
  const waived = data?.filter((c) => c.status === "waived").length || 0;
  const pending = data?.filter((c) => c.status === "pending").length || 0;

  return NextResponse.json({
    data,
    summary: {
      total,
      passed,
      failed,
      waived,
      pending,
      allPassed: (passed + waived) === total && total > 0,
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const checkId = body.check_id as string;

  if (!checkId) {
    return NextResponse.json(
      { error: "check_id is required" },
      { status: 400 }
    );
  }

  const result = updateComplianceCheckSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Verify the check belongs to this case
  const { data: existingCheck, error: fetchError } = await supabase
    .from("case_compliance_checks")
    .select("id, status, case_id")
    .eq("id", checkId)
    .eq("case_id", caseId)
    .single();

  if (fetchError || !existingCheck) {
    return NextResponse.json(
      { error: "Compliance check not found" },
      { status: 404 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to update compliance checks" }, { status: 403 });
  }

  const { data: updatedCheck, error: updateError } = await supabase
    .from("case_compliance_checks")
    .update({
      status: result.data.status,
      notes: result.data.notes,
      checked_by: dbUser?.id,
      checked_at: new Date().toISOString(),
    })
    .eq("id", checkId)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message },
      { status: 500 }
    );
  }

  // Check if all compliance checks now pass — auto-update case
  const { data: allChecks } = await supabase
    .from("case_compliance_checks")
    .select("status")
    .eq("case_id", caseId);

  const allPassed = (allChecks || []).every(
    (c) => c.status === "passed" || c.status === "waived"
  );

  if (allPassed) {
    await supabase
      .from("cases")
      .update({
        compliance_passed: true,
        compliance_passed_at: new Date().toISOString(),
      })
      .eq("id", caseId);

    await advanceCaseStage(supabase, caseId, "internal_approved");
  }

  // Audit log
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "case",
      entityId: caseId,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        compliance_check: {
          old: existingCheck.status,
          new: result.data.status,
        },
      },
    });
  }

  return NextResponse.json({ data: updatedCheck });
}
