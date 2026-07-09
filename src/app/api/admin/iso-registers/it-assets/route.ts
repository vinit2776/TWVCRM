import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateIsoRegisterPDF } from "@/lib/iso-register-pdf";
import { formatDate } from "@/lib/utils";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "fms", "it_manager", "it_technician"];

const STATUS_LABELS: Record<string, string> = {
  active: "Working",
  maintenance: "Under Maintenance",
  retired: "Retired",
};

/**
 * GET /api/admin/iso-registers/it-assets
 *
 * Auditor-ready export of SDI/ITSS/F/01 "IT Asset Register" — pulled live
 * from facility_assets. Filtered by purchase_date (falling back to
 * created_at for assets with no purchase date on file) in range.
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
    .from("facility_assets")
    .select(`
      asset_code, name, make, model, serial_number, purchase_date, created_at,
      assigned_department, status, next_service_due, notes,
      location:locations(name),
      floor:location_floors(name),
      category:facility_asset_categories(name)
    `)
    .order("sort_order", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assets = (data ?? []) as any[];
  const inRange = assets.filter((a) => {
    const anchor = (a.purchase_date || a.created_at || "").slice(0, 10);
    return anchor >= dateFrom && anchor <= dateTo;
  });

  const rows = inRange.map((asset, i) => ({
    sno: String(i + 1),
    category: asset.category?.name || "",
    name: asset.name || "",
    make_model: [asset.make, asset.model].filter(Boolean).join(" / "),
    serial_number: asset.serial_number || "",
    location: asset.location?.name || "",
    floor: asset.floor?.name || "",
    purchase_date: asset.purchase_date ? formatDate(asset.purchase_date) : "",
    assigned_to: asset.assigned_department || "",
    status: STATUS_LABELS[asset.status] || asset.status,
    next_service_due: asset.next_service_due ? formatDate(asset.next_service_due) : "",
    remarks: asset.notes || "",
  }));

  const doc = generateIsoRegisterPDF({
    docNo: "SDI/ITSS/F/01",
    revNo: "00",
    revDate: "28-11-2025",
    title: "IT ASSET REGISTER",
    filterLine: `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`,
    columns: [
      { header: "S.No", dataKey: "sno", width: 9 },
      { header: "Asset Category", dataKey: "category", width: 26 },
      { header: "Asset Name / Description", dataKey: "name", width: 30 },
      { header: "Make / Model", dataKey: "make_model", width: 26 },
      { header: "Serial Number", dataKey: "serial_number", width: 26 },
      { header: "Location / Branch", dataKey: "location", width: 26 },
      { header: "Floor / Room / Rack", dataKey: "floor", width: 24 },
      { header: "Date of Purchase", dataKey: "purchase_date", width: 20 },
      { header: "Assigned To (Employee / Dept.)", dataKey: "assigned_to", width: 28 },
      { header: "Current Status", dataKey: "status", width: 20 },
      { header: "Next Service Due", dataKey: "next_service_due", width: 20 },
      { header: "Remarks", dataKey: "remarks" },
    ],
    rows,
  });

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="SDI-ITSS-F-01_${dateFrom}_to_${dateTo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
