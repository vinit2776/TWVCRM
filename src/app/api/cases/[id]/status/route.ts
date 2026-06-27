import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { transitionCaseStatusSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { CASE_STATUS_TRANSITIONS } from "@/lib/constants";

// Map of status → timestamp field to set
const STATUS_TIMESTAMP_MAP: Record<string, string> = {
  docs_requested: "docs_requested_at",
  docs_received: "docs_received_at",
  under_review: "review_started_at",
  internal_approved: "internal_approved_at",
  sent_for_client_approval: "sent_for_client_approval_at",
  client_approved: "client_approved_at",
  signing_in_progress: "signing_started_at",
  executed: "executed_at",
  invoiced: "invoiced_at",
  active: "activated_at",
  renewed: "renewed_at",
  lapsed: "lapsed_at",
};

export async function POST(
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
  const result = transitionCaseStatusSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const newStatus = result.data.status;

  // Fetch current case
  const { data: currentCase, error: fetchError } = await supabase
    .from("cases")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !currentCase) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  const currentStatus = currentCase.status as string;

  // Validate transition is allowed
  const allowedTransitions = CASE_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowedTransitions.includes(newStatus)) {
    return NextResponse.json(
      {
        error: `Cannot transition from "${currentStatus}" to "${newStatus}". Allowed: ${allowedTransitions.join(", ") || "none"}`,
      },
      { status: 400 }
    );
  }

  // Gate checks for specific transitions
  if (newStatus === "compliance_check") {
    // All required documents must be approved
    const { data: docs } = await supabase
      .from("case_documents")
      .select("status, is_required")
      .eq("case_id", id);

    const pendingRequired = (docs || []).filter(
      (d) => d.is_required && d.status !== "approved"
    );

    if (pendingRequired.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot proceed to compliance check. ${pendingRequired.length} required document(s) are not yet approved.`,
        },
        { status: 400 }
      );
    }
  }

  if (newStatus === "internal_approved") {
    // All compliance checks must be passed or waived
    const { data: checks } = await supabase
      .from("case_compliance_checks")
      .select("status")
      .eq("case_id", id);

    const pendingChecks = (checks || []).filter(
      (c) => c.status !== "passed" && c.status !== "waived"
    );

    if (pendingChecks.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot approve internally. ${pendingChecks.length} compliance check(s) are still pending or failed.`,
        },
        { status: 400 }
      );
    }
  }

  // Build update payload
  const updateData: Record<string, unknown> = {
    status: newStatus,
  };

  // Set the corresponding timestamp
  const timestampField = STATUS_TIMESTAMP_MAP[newStatus];
  if (timestampField) {
    updateData[timestampField] = new Date().toISOString();
  }

  // Get the DB user
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  // Review & approval stage transitions are restricted
  const REVIEW_APPROVAL_STATUSES = [
    "under_review", "compliance_check", "internal_approved",
    "sent_for_client_approval", "client_approved",
  ];
  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (REVIEW_APPROVAL_STATUSES.includes(newStatus) && (!dbUser || !ALLOWED_ROLES.includes(dbUser.role))) {
    return NextResponse.json({ error: "Not authorized to move cases through review and approval" }, { status: 403 });
  }

  // Set internal_approved_by when internally approving
  if (newStatus === "internal_approved" && dbUser?.id) {
    updateData.internal_approved_by = dbUser.id;
  }

  // Set compliance_passed flag when moving to internal_approved
  if (newStatus === "internal_approved") {
    updateData.compliance_passed = true;
    updateData.compliance_passed_at = new Date().toISOString();
  }

  // Calculate renewal_due_at when moving to active
  if (newStatus === "active" && currentCase.start_date && currentCase.tenure_months) {
    const startDate = new Date(currentCase.start_date);
    startDate.setMonth(startDate.getMonth() + currentCase.tenure_months);
    // Set renewal due 30 days before end
    startDate.setDate(startDate.getDate() - 30);
    updateData.renewal_due_at = startDate.toISOString();
  }

  // Update the case
  const { data, error } = await supabase
    .from("cases")
    .update(updateData)
    .eq("id", id)
    .select(
      "*, aggregator:aggregators!cases_aggregator_id_fkey(id, name, code), location:locations!cases_location_id_fkey(id, name, code), assignee:users!cases_assigned_to_fkey(id, full_name, email)"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "case",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: currentStatus, new: newStatus },
        ...(result.data.notes
          ? { transition_notes: { old: null, new: result.data.notes } }
          : {}),
      },
    });
  }

  return NextResponse.json({ data });
}
