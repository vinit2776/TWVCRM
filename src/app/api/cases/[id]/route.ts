import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
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
  const [caseRes, docsRes, complianceRes, agreementRes, llAgreementRes, billingRes, commentsRes] =
    await Promise.all([
      supabase
        .from("cases")
        .select(
          "*, aggregator:aggregators!cases_aggregator_id_fkey(id, name, code, primary_email, billing_method), aggregator_contact:aggregator_contacts!cases_aggregator_contact_id_fkey(id, name, email, phone), location:locations!cases_location_id_fkey(id, name, code), assignee:users!cases_assigned_to_fkey(id, full_name, email)"
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
        .from("billing_statements")
        .select("id, statement_number, payment_status, handoff_state, total_amount, voided_at")
        .eq("case_id", id)
        .eq("statement_type", "vo_case")
        .is("voided_at", null)
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
      billing_statement: billingRes.data?.[0] || null,
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

  // billing_statements.case_id is ON DELETE SET NULL, but a vo_case statement
  // (src/lib/case-invoicing.ts) is typically owned by case_id alone — no
  // contract/booking/proposal/invoice/aggregator. Nulling out its only source
  // reference violates billing_statements_source_check and fails the whole
  // case delete with a raw Postgres error. Since these statements have no
  // reason to survive their case's deletion, remove case-only-owned ones
  // first — unless they're already paid or Tally-issued, in which case block
  // the delete instead of silently destroying real financial records.
  const { data: caseStatements } = await supabase
    .from("billing_statements")
    .select("id, statement_number, issuance_channel, contract_id, booking_id, proposal_id, invoice_id, aggregator_id")
    .eq("case_id", id);

  const caseOnlyStatements = (caseStatements ?? []).filter(
    (s) => !s.contract_id && !s.booking_id && !s.proposal_id && !s.invoice_id && !s.aggregator_id
  );

  for (const statement of caseOnlyStatements) {
    if (statement.issuance_channel === "tally") {
      return NextResponse.json(
        {
          error: `Cannot delete — invoice ${statement.statement_number ?? statement.id.slice(0, 8)} was issued by Tally. Handle it via the cancel/credit-note flow before deleting this case.`,
        },
        { status: 409 }
      );
    }

    const { data: payments } = await supabase
      .from("billing_payments")
      .select("id")
      .eq("billing_statement_id", statement.id)
      .limit(1);

    if (payments && payments.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete — invoice ${statement.statement_number ?? statement.id.slice(0, 8)} has payments recorded. Reverse or delete payments first.`,
        },
        { status: 409 }
      );
    }
  }

  if (caseOnlyStatements.length > 0) {
    // billing_statements has RLS enabled with no DELETE policy for
    // `authenticated` (only SELECT/INSERT/UPDATE) — the RLS-scoped client
    // would silently delete 0 rows here, leaving the case delete below to
    // still hit the same constraint violation. Admin client required.
    const adminSupabase = await createAdminClient();
    const { error: statementDeleteError } = await adminSupabase
      .from("billing_statements")
      .delete()
      .in("id", caseOnlyStatements.map((s) => s.id));

    if (statementDeleteError) {
      return NextResponse.json({ error: statementDeleteError.message }, { status: 500 });
    }
  }

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
