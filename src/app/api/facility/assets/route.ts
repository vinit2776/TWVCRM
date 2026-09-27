import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const categoryId = searchParams.get("category_id");
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const format = searchParams.get("format");
  const includeStats = searchParams.get("include_stats") === "true" || format === "csv";

  let query = supabase
    .from("facility_assets")
    .select(`
      *,
      location:locations(id, name, code),
      floor:location_floors(id, name),
      space_unit:space_units(id, name, code),
      category:facility_asset_categories(id, name, slug, scope, icon)
    `)
    .order("location_id", { ascending: true })
    .order("sort_order", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);
  if (categoryId) query = query.eq("category_id", categoryId);
  if (status) query = query.eq("status", status);
  if (search) {
    const s = `%${search}%`;
    query = query.or(`name.ilike.${s},asset_code.ilike.${s},serial_number.ilike.${s},mac_address.ilike.${s}`);
  }

  const { data: assets, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Optional: enrich with issue counts
  if (includeStats && assets && assets.length > 0) {
    const ids = assets.map((a) => a.id);
    const { data: issueRows } = await supabase
      .from("facility_issues")
      .select("asset_id, status, created_at")
      .in("asset_id", ids);

    const stats = new Map<string, { open: number; total: number; last: string | null }>();
    for (const row of issueRows || []) {
      const aid = row.asset_id as string;
      const s = stats.get(aid) || { open: 0, total: 0, last: null };
      s.total += 1;
      if (["new", "acknowledged", "in_progress", "reopened"].includes(row.status as string)) s.open += 1;
      if (!s.last || (row.created_at as string) > s.last) s.last = row.created_at as string;
      stats.set(aid, s);
    }

    for (const a of assets) {
      const s = stats.get(a.id) || { open: 0, total: 0, last: null };
      a.open_issue_count = s.open;
      a.total_issue_count = s.total;
      a.last_issue_at = s.last;
    }
  }

  if (format === "csv") {
    // Intentionally does not join facility_asset_credentials -- the query
    // above never touches that table, so there's no decrypted (or even
    // encrypted) password anywhere in this response to leak into a bulk
    // export. Keep it that way if this list ever grows more columns.
    //
    // Excel and Sheets execute any cell whose text starts with = + - @ (or a
    // leading tab/CR) as a formula. These columns are free text an operator
    // typed in, so without this a note beginning "=" runs as a formula on
    // whoever opens the export. A leading apostrophe pins the cell back to
    // text without changing what it reads as.
    const esc = (v: unknown) => {
      const raw = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = [
      "Asset Code", "Name", "Location", "Floor", "Category", "Status",
      "Make", "Model", "Serial Number", "MAC Address", "IP Address", "Vendor",
      "Purchase Date", "Warranty Expiry", "Installation Date", "Next Service Due",
      "Assigned Department", "Open Issues", "Total Issues", "Location Notes", "Notes",
    ].join(",");
    const lines = (assets || []).map((a) =>
      [
        esc(a.asset_code), esc(a.name), esc(a.location?.name), esc(a.floor?.name),
        esc(a.category?.name), esc(a.status),
        esc(a.make), esc(a.model), esc(a.serial_number), esc(a.mac_address), esc(a.ip_address), esc(a.vendor),
        esc(a.purchase_date?.slice(0, 10)), esc(a.warranty_expiry?.slice(0, 10)),
        esc(a.installation_date?.slice(0, 10)), esc(a.next_service_due?.slice(0, 10)),
        esc(a.assigned_department), a.open_issue_count ?? 0, a.total_issue_count ?? 0,
        esc(a.location_notes), esc(a.notes),
      ].join(",")
    );
    // Excel assumes the system codepage without a BOM, which mangles ₹ and any
    // non-ASCII name in the free-text columns.
    const csv = "\ufeff" + [header, ...lines].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="facility-assets-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({ data: assets || [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const body = await request.json();
  const {
    location_id, floor_id, space_unit_id, category_id,
    name, asset_code, make, model, serial_number, mac_address, ip_address,
    purchase_date, warranty_expiry, vendor, status = "active",
    lifecycle_stage = "operational", installation_date,
    custom_field_values, procurement_po_id,
    location_notes, notes, attention_notes, sort_order = 0,
    assigned_department, next_service_due,
  } = body;

  if (!location_id || !category_id || !name || !asset_code) {
    return NextResponse.json({ error: "location_id, category_id, name and asset_code are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("facility_assets")
    .insert({
      location_id, floor_id: floor_id || null, space_unit_id: space_unit_id || null,
      category_id,
      name: String(name).trim(),
      asset_code: String(asset_code).trim().toUpperCase(),
      make: make || null, model: model || null,
      serial_number: serial_number || null,
      mac_address: mac_address || null,
      ip_address: ip_address || null,
      purchase_date: purchase_date || null,
      warranty_expiry: warranty_expiry || null,
      vendor: vendor || null,
      status,
      lifecycle_stage: lifecycle_stage || "operational",
      installation_date: installation_date || null,
      custom_field_values: custom_field_values || {},
      procurement_po_id: procurement_po_id || null,
      location_notes: location_notes || null,
      notes: notes || null,
      attention_notes: attention_notes || null,
      assigned_department: assigned_department || null,
      next_service_due: next_service_due || null,
      sort_order: Number(sort_order),
      created_by: dbUser!.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "An asset with this code already exists at this location" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "facility_asset",
    entityId: data.id, action: "create", performedBy: dbUser!.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}
