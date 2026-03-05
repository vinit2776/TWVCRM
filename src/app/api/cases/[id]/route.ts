import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateCaseSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

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

  // Fetch case with all related data
  const [caseRes, docsRes, complianceRes, agreementRes, llAgreementRes, commentsRes] =
    await Promise.all([
      supabase
        .from("cases")
        .select(
          "*, aggregator:aggregators!cases_aggregator_id_fkey(id, name, code, primary_email), aggregator_contact:aggregator_contacts!cases_aggregator_contact_id_fkey(id, name, email, phone), location:locations!cases_location_id_fkey(id, name, code), assignee:users!cases_assigned_to_fkey(id, full_name, email)"
        )
        .eq("id", id)
        .single(),
      supabase
        .from("case_documents")
        .select("*")
        .eq("case_id", id)
        .order("is_required", { ascending: false })
        .order("created_at", { ascending: true }),
      supabase
        .from("case_compliance_checks")
        .select("*")
        .eq("case_id", id)
        .order("sort_order", { ascending: true }),
      supabase
        .from("case_agreements")
        .select("*")
        .eq("case_id", id)
        .eq("type", "proposal")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("case_agreements")
        .select("*")
        .eq("case_id", id)
        .eq("type", "leave_license")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("case_comments")
        .select(
          "*, creator:users!case_comments_created_by_fkey(id, full_name, email)"
        )
        .eq("case_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  if (caseRes.error) {
    return NextResponse.json({ error: caseRes.error.message }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      ...caseRes.data,
      documents: docsRes.data || [],
      compliance_checks: complianceRes.data || [],
      agreement: agreementRes.data?.[0] || null,
      ll_agreement: llAgreementRes.data?.[0] || null,
      comments: commentsRes.data || [],
    },
  });
}

export async function PATCH(
  request: NextRequest,
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

  const body = await request.json();
  const result = updateCaseSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Fetch current state for audit diff
  const { data: oldCase } = await supabase
    .from("cases")
    .select("*")
    .eq("id", id)
    .single();

  const { data, error } = await supabase
    .from("cases")
    .update(result.data)
    .eq("id", id)
    .select(
      "*, aggregator:aggregators!cases_aggregator_id_fkey(id, name, code), location:locations!cases_location_id_fkey(id, name, code), assignee:users!cases_assigned_to_fkey(id, full_name, email)"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.id && oldCase) {
    logAudit(supabase, {
      entityType: "case",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(
        oldCase as Record<string, unknown>,
        result.data as Record<string, unknown>
      ),
    });
  }

  return NextResponse.json({ data });
}

export async function DELETE(
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

  // Only allow deleting cases in intake_received status
  const { data: existingCase } = await supabase
    .from("cases")
    .select("status")
    .eq("id", id)
    .single();

  if (existingCase && existingCase.status !== "intake_received") {
    return NextResponse.json(
      {
        error:
          "Cannot delete a case that has progressed beyond intake. Consider lapsing it instead.",
      },
      { status: 400 }
    );
  }

  // Capture before delete for audit
  const { data: oldCase } = await supabase
    .from("cases")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("cases").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "case",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: oldCase, new: null } },
    });
  }

  return NextResponse.json({ message: "Case deleted" });
}
