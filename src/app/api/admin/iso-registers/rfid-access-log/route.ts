import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate } from "@/lib/utils";
import { resolveEntityDetailsBatch } from "@/lib/cosec-entity-resolution";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

/**
 * GET /api/admin/iso-registers/rfid-access-log
 *
 * Auditor-ready export of SDI/ITSS/F/10 "RFID Door Access Log" — pulled live
 * from access_logs (every COSEC IN/OUT/DENIED swipe), joined to cosec_devices
 * for the door name and batch-resolved against contracts/members/employees/
 * bookings for cardholder name, company, and current cabin.
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
  const deviceId = searchParams.get("device_id");

  const admin = createAdminClient();
  let query = admin
    .from("access_logs")
    .select("entity_id, user_type, direction, event_time, device:cosec_devices(label)")
    .gte("event_time", dateFrom)
    .lte("event_time", `${dateTo}T23:59:59`)
    .order("event_time", { ascending: true })
    .limit(2000);

  if (deviceId) query = query.eq("device_id", deviceId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs = (data ?? []) as any[];
  const details = await resolveEntityDetailsBatch(
    admin,
    logs.map((l) => ({ entityId: l.entity_id, userType: l.user_type }))
  );

  const rows = logs.map((log, i) => {
    const key = `${log.user_type ?? "unknown"}:${log.entity_id}`;
    const resolved = details.get(key);
    const accessStatus = log.direction === "DENIED" ? "Denied" : "Granted";
    return {
      sno: String(i + 1),
      date: formatDate(log.event_time),
      time: new Date(log.event_time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }),
      card_holder_name: resolved?.name || "",
      company: resolved?.company || "",
      cabin: resolved?.cabin || "",
      access_card_no: resolved?.cardNumber || "",
      door_area: log.device?.label || "",
      access_status: accessStatus,
      remarks: "",
    };
  });

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/ITSS/F/10",
    revNo: "00",
    revDate: "28-11-2025",
    title: "RFID DOOR ACCESS LOG",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Date", dataKey: "date", width: 20 },
      { header: "Time", dataKey: "time", width: 16 },
      { header: "Card Holder Name", dataKey: "card_holder_name", width: 30 },
      { header: "Company / Client Name", dataKey: "company", width: 34 },
      { header: "LOA No. / Cabin / Desk No.", dataKey: "cabin", width: 30 },
      { header: "Access Card No.", dataKey: "access_card_no", width: 30 },
      { header: "Door / Area Accessed", dataKey: "door_area", width: 28 },
      { header: "Access Status", dataKey: "access_status", width: 20 },
      { header: "Remarks", dataKey: "remarks" },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-ITSS-F-10_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
