import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate } from "@/lib/utils";
import { PRIORITY_STYLES, STATUS_STYLES, SCOPE_LABEL } from "@/lib/facility-ui";
import type { FacilityIssuePriority, FacilityIssueStatus, FacilityScope } from "@/types";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

/**
 * GET /api/admin/iso-registers/facility-tickets
 *
 * Auditor-ready export of SDI/OPFM/F/16 "Facilities Management Ticketing
 * System" — pulled live from facility_issues (scope != 'it').
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const dateFrom = searchParams.get("from") || defaultFrom;
  const dateTo = searchParams.get("to") || defaultTo;
  const locationId = searchParams.get("location_id");

  const admin = createAdminClient();
  let query = admin
    .from("facility_issues")
    .select(`
      issue_number, reported_at, reporter_name, description, priority, status,
      resolution_notes, resolved_at, scope,
      location:locations(name),
      asset:facility_assets(name),
      category:facility_asset_categories(name),
      assignee:users!facility_issues_assigned_to_fkey(full_name)
    `)
    .neq("scope", "it")
    .gte("reported_at", dateFrom)
    .lte("reported_at", `${dateTo}T23:59:59`)
    .order("reported_at", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues = (data ?? []) as any[];
  const rows = issues.map((issue, i) => ({
    sno: String(i + 1),
    ticket_id: issue.issue_number,
    date_raised: formatDate(issue.reported_at),
    raised_by: issue.reporter_name || "",
    department_area: [issue.category?.name || SCOPE_LABEL[issue.scope as FacilityScope], issue.location?.name]
      .filter(Boolean)
      .join(" / "),
    item: issue.asset?.name || "",
    description: issue.description || "",
    priority: PRIORITY_STYLES[issue.priority as FacilityIssuePriority]?.label || issue.priority,
    status: STATUS_STYLES[issue.status as FacilityIssueStatus]?.label || issue.status,
    assigned_to: issue.assignee?.full_name || "",
    action_taken: issue.resolution_notes || "",
    date_resolved: issue.resolved_at ? formatDate(issue.resolved_at) : "",
    remarks: "",
  }));

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/OPFM/F/16",
    revNo: "00",
    revDate: "28-11-2025",
    title: "FACILITIES MANAGEMENT TICKETING SYSTEM",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Ticket ID", dataKey: "ticket_id", width: 24 },
      { header: "Date Raised", dataKey: "date_raised", width: 20 },
      { header: "Raised By", dataKey: "raised_by", width: 24 },
      { header: "Department / Area", dataKey: "department_area", width: 32 },
      { header: "Item / Furniture", dataKey: "item", width: 24 },
      { header: "Issue Description", dataKey: "description" },
      { header: "Priority", dataKey: "priority", width: 16 },
      { header: "Status", dataKey: "status", width: 20 },
      { header: "Assigned To", dataKey: "assigned_to", width: 24 },
      { header: "Action Taken", dataKey: "action_taken", width: 32 },
      { header: "Date Resolved", dataKey: "date_resolved", width: 20 },
      { header: "Remarks", dataKey: "remarks", width: 18 },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-OPFM-F-16_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
