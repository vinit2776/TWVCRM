import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate } from "@/lib/utils";
import { BOOKING_STATUS_LABELS, BOOKING_PAYMENT_STATUS_LABELS } from "@/lib/constants";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

function formatTime12(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * GET /api/admin/iso-registers/conference-bookings
 *
 * Auditor-ready export of SDI/OPFM/F/10 "Conference Room Booking Calendar/
 * Log" — pulled live from bookings (all room/day-pass bookings; `spaces.
 * workspace_type` is free text with no fixed enum, so this intentionally
 * doesn't try to filter to "conference room only" and instead covers every
 * booking in range, matching the sheet's actual usage).
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
    .from("bookings")
    .select(`
      booking_number, booking_date, start_time, end_time, guest_name, guest_company,
      loi_number, purpose, num_attendees, access_provided_by, status, payment_status, notes,
      space:spaces(name),
      contract:contracts(lead:leads!contracts_lead_id_fkey(company, first_name, last_name))
    `)
    .gte("booking_date", dateFrom)
    .lte("booking_date", dateTo)
    .order("booking_date", { ascending: true })
    .order("start_time", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookings = (data ?? []) as any[];
  const rows = bookings.map((b, i) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = b.contract?.lead as any;
    const clientName = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || b.guest_company || b.guest_name || "";
    return {
      sno: String(i + 1),
      booking_date: formatDate(b.booking_date),
      room: b.space?.name || "",
      client_name: clientName,
      loi_number: b.loi_number || "",
      start_time: formatTime12(b.start_time),
      end_time: formatTime12(b.end_time),
      purpose: b.purpose || "",
      attendees: b.num_attendees != null ? String(b.num_attendees) : "",
      access_provided_by: b.access_provided_by || "",
      status: BOOKING_STATUS_LABELS[b.status] || b.status,
      payment_status: BOOKING_PAYMENT_STATUS_LABELS[b.payment_status] || b.payment_status,
      remarks: b.notes || "",
    };
  });

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/OPFM/F/10",
    revNo: "01",
    revDate: "23-02-2026",
    title: "CONFERENCE ROOM BOOKING CALENDAR/LOG",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Booking Date", dataKey: "booking_date", width: 20 },
      { header: "Meeting Room", dataKey: "room", width: 22 },
      { header: "Client Name", dataKey: "client_name", width: 28 },
      { header: "LOI No.", dataKey: "loi_number", width: 18 },
      { header: "Start Time", dataKey: "start_time", width: 16 },
      { header: "End Time", dataKey: "end_time", width: 16 },
      { header: "Purpose of Meeting", dataKey: "purpose", width: 26 },
      { header: "Attendees", dataKey: "attendees", width: 14 },
      { header: "Access Provided By", dataKey: "access_provided_by", width: 22 },
      { header: "Status", dataKey: "status", width: 18 },
      { header: "Payment Status", dataKey: "payment_status", width: 22 },
      { header: "Remarks", dataKey: "remarks" },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-OPFM-F-10_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
