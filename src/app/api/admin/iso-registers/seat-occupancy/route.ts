import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate } from "@/lib/utils";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

/**
 * GET /api/admin/iso-registers/seat-occupancy
 *
 * Auditor-ready export of SDI/OPFM/F/09 "Seat Occupancy Tracker" — pulled
 * live from space_seat_occupants (filtered by start_date in range), joined
 * to space_units for capacity and contracts/leads for client name.
 *
 * "Check-in"/"Check-out" on the client's paper form are, per the sample
 * data, full contract-span dates rather than times of day — mapped here to
 * start_date/end_date rather than adding a new daily-time-log feature.
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

  // Current active occupant counts per space unit, for Seats Occupied / Vacant.
  const { data: activeOccupants } = await admin
    .from("space_seat_occupants")
    .select("space_unit_id")
    .eq("status", "active");
  const occupiedByUnit = new Map<string, number>();
  for (const o of activeOccupants ?? []) {
    occupiedByUnit.set(o.space_unit_id, (occupiedByUnit.get(o.space_unit_id) ?? 0) + 1);
  }

  let query = admin
    .from("space_seat_occupants")
    .select(`
      seat_label, occupant_name, loi_number, start_date, end_date, notes, space_unit_id,
      location_id,
      space_unit:space_units(name, type, capacity),
      contract:contracts(lead:leads!contracts_lead_id_fkey(company, first_name, last_name))
    `)
    .gte("start_date", dateFrom)
    .lte("start_date", dateTo)
    .order("start_date", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const occupants = (data ?? []) as any[];
  const rows = occupants.map((o, i) => {
    const capacity = o.space_unit?.capacity ?? 0;
    const occupied = occupiedByUnit.get(o.space_unit_id) ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = o.contract?.lead as any;
    const clientName = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || o.occupant_name;
    return {
      sno: String(i + 1),
      date: formatDate(o.start_date),
      client_name: clientName,
      loi_number: o.loi_number || "",
      seat: o.seat_label || o.space_unit?.name || "",
      workspace_type: (o.space_unit?.type || "").replace(/_/g, " "),
      seats_allocated: String(capacity),
      seats_occupied: String(Math.min(occupied, capacity || occupied)),
      seats_vacant: String(Math.max(capacity - occupied, 0)),
      check_in: formatDate(o.start_date),
      check_out: o.end_date ? formatDate(o.end_date) : "",
      floor_incharge: "",
      remarks: o.notes || "",
    };
  });

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/OPFM/F/09",
    revNo: "00",
    revDate: "28-11-2025",
    title: "SEAT OCCUPANCY TRACKER",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Date", dataKey: "date", width: 18 },
      { header: "Client Name", dataKey: "client_name", width: 30 },
      { header: "LOI Number", dataKey: "loi_number", width: 20 },
      { header: "Seat / Desk / Cabin", dataKey: "seat", width: 22 },
      { header: "Workspace Type", dataKey: "workspace_type", width: 20 },
      { header: "Total Allocated", dataKey: "seats_allocated", width: 16 },
      { header: "Occupied", dataKey: "seats_occupied", width: 14 },
      { header: "Vacant", dataKey: "seats_vacant", width: 14 },
      { header: "Check-in", dataKey: "check_in", width: 18 },
      { header: "Check-out", dataKey: "check_out", width: 18 },
      { header: "Floor Incharge", dataKey: "floor_incharge", width: 20 },
      { header: "Remarks", dataKey: "remarks" },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-OPFM-F-09_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
