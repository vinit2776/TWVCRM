import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate, formatDateTime } from "@/lib/utils";
import { PRIORITY_STYLES, STATUS_STYLES } from "@/lib/facility-ui";
import type { FacilityIssuePriority, FacilityIssueStatus } from "@/types";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

/**
 * GET /api/admin/iso-registers/it-tickets
 *
 * Auditor-ready export of SDI/ITSS/F/05 "IT Ticket Register" — pulled live
 * from facility_issues (scope = 'it').
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
      issue_number, reported_at, reporter_name, reporter_phone, description, priority, status,
      resolution_notes, resolved_at,
      category:facility_asset_categories!facility_issues_category_id_fkey(name)
    `)
    .eq("scope", "it")
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
    date_time: formatDateTime(issue.reported_at),
    reported_by: issue.reporter_name || "",
    contact_number: issue.reporter_phone || "",
    issue_category: issue.category?.name || "",
    description: issue.description || "",
    priority: PRIORITY_STYLES[issue.priority as FacilityIssuePriority]?.label || issue.priority,
    status: STATUS_STYLES[issue.status as FacilityIssueStatus]?.label || issue.status,
    action_taken: issue.resolution_notes || "",
    resolution_date: issue.resolved_at ? formatDateTime(issue.resolved_at) : "",
    verified_by: "",
  }));

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/ITSS/F/05",
    revNo: "00",
    revDate: "28-11-2025",
    title: "IT TICKET REGISTER",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Ticket ID", dataKey: "ticket_id", width: 20 },
      { header: "Date & Time", dataKey: "date_time", width: 26 },
      { header: "Reported By", dataKey: "reported_by", width: 24 },
      { header: "Contact No.", dataKey: "contact_number", width: 22 },
      { header: "Issue Category", dataKey: "issue_category", width: 26 },
      { header: "Issue Description", dataKey: "description" },
      { header: "Priority", dataKey: "priority", width: 16 },
      { header: "Status", dataKey: "status", width: 18 },
      { header: "Action Taken", dataKey: "action_taken", width: 30 },
      { header: "Resolution Date & Time", dataKey: "resolution_date", width: 26 },
      { header: "Verified By", dataKey: "verified_by", width: 18 },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-ITSS-F-05_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
