import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/locations/[id]/print-template
 * Returns the location_print_templates row for this location, or null.
 * The detailed column-mapping editor (Batch 2) consumes this; for Batch 1
 * we mainly use it to show whether a sample file has already been uploaded.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("location_print_templates")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

/**
 * POST /api/locations/[id]/print-template  (multipart/form-data)
 * Field: `file` — the sample xlsx the location's print server exports.
 *
 * Stores the file under `service-imports/templates/<location_id>/<timestamp>.xlsx`
 * and creates or updates the `location_print_templates` row with the file path.
 *
 * Column mappings get filled in later via the dedicated mapping UI in Batch 2 —
 * this endpoint is only the "save the sample so we have something to map against"
 * step and is intentionally optional ("passive") at location creation time.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  // Confirm the location exists before we write storage / row
  const { data: loc } = await supabase
    .from("locations").select("id, name").eq("id", id).single();
  if (!loc) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  // Light validation; full normalization happens at upload time when
  // we actually parse it. xlsx (the only thing this endpoint accepts).
  const name = (file as File).name || "template.xlsx";
  const lower = name.toLowerCase();
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls") && !lower.endsWith(".csv")) {
    return NextResponse.json({ error: "Upload an .xlsx, .xls or .csv file" }, { status: 400 });
  }
  if ((file as File).size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 400 });
  }

  const ext = lower.split(".").pop() || "xlsx";
  const path = `templates/${id}/${Date.now()}.${ext}`;
  const buf = Buffer.from(await (file as File).arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from("service-imports")
    .upload(path, buf, {
      contentType: (file as File).type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      upsert: false,
    });
  if (upErr) return NextResponse.json({ error: `Upload failed: ${upErr.message}` }, { status: 500 });

  // Upsert the template row. We default the column-map fields to placeholder
  // values; the mapping editor (Batch 2) lets admin click cells to set them.
  // For the sample file we got, we leave the mapping blank — it's not used
  // until someone actually does the mapping step.
  const { data: existing } = await supabase
    .from("location_print_templates")
    .select("id")
    .eq("location_id", id)
    .maybeSingle();

  let row;
  if (existing) {
    const { data, error } = await supabase
      .from("location_print_templates")
      .update({
        sample_file_path: path,
        sample_file_name: name,
        updated_by: dbUser.id,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    row = data;
  } else {
    // First-time creation: stash the sample with sensible defaults that
    // match the original Nungambakam LGF report we have in hand. Column
    // letters are placeholders — the admin overrides them via the mapping
    // editor in Batch 2 if their location's format differs.
    const { data, error } = await supabase
      .from("location_print_templates")
      .insert({
        location_id: id,
        header_rows: 3,
        data_start_row: 4,
        dept_id_col: "A",
        bw_total_col: "D",
        colour_total_col: "C",
        bw_copy_col: "H",
        bw_print_col: "J",
        bw_scan_col: "I",
        colour_copy_col: "E",
        colour_print_col: "G",
        colour_scan_col: "F",
        quota_format: "used_slash_quota",
        sample_file_path: path,
        sample_file_name: name,
        created_by: dbUser.id,
        updated_by: dbUser.id,
      })
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    row = data;
  }

  logAudit(supabase, {
    entityType: "location_print_template", entityId: row.id, action: existing ? "update" : "create",
    performedBy: dbUser.id, changes: { sample_file_path: { old: null, new: path } },
  });

  return NextResponse.json({ data: row });
}

/**
 * DELETE /api/locations/[id]/print-template
 * Removes the saved sample file and clears the template row. The admin uses
 * this to start over (e.g. printer vendor changed export format).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const { data: existing } = await supabase
    .from("location_print_templates")
    .select("id, sample_file_path")
    .eq("location_id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ success: true });

  if (existing.sample_file_path) {
    await supabase.storage.from("service-imports").remove([existing.sample_file_path]);
  }
  await supabase.from("location_print_templates").delete().eq("id", existing.id);

  logAudit(supabase, {
    entityType: "location_print_template", entityId: existing.id, action: "delete",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ success: true });
}
