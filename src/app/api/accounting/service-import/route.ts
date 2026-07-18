/**
 * /api/accounting/service-import
 *
 * GET  — list past imports (most recent first)
 * POST — upload a printer usage CSV/XLSX for a location + billing period,
 *         parse it against the location's print template, compute overage
 *         against each contract's service quotas, and return a preview.
 *         The import row is saved with status = "preview" so the admin can
 *         review before confirming.  Call the [id]/confirm endpoint to
 *         finalise and create usage_charges.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Papa from "papaparse";
import type { ServiceImportPreviewRow } from "@/types";
import { isContractOperational } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an Excel column letter (A, B, … Z, AA …) to a 0-based index. */
function colLetterToIndex(col: string): number {
  let idx = 0;
  for (const ch of col.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1; // 0-based
}

/** Safely parse a cell value as a number (handles "123/500" → 123). */
function parseNumeric(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const str = String(raw).trim();
  // "used/quota" format — take the part before the slash
  const beforeSlash = str.split("/")[0].replace(/,/g, "").trim();
  const num = parseFloat(beforeSlash);
  return isNaN(num) ? 0 : num;
}

// ---------------------------------------------------------------------------
// GET — list imports
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const year       = searchParams.get("year");
  const month      = searchParams.get("month");
  const page       = parseInt(searchParams.get("page") || "1");
  const limit      = parseInt(searchParams.get("limit") || "25");
  const offset     = (page - 1) * limit;

  let query = supabase
    .from("service_usage_imports")
    .select(
      "id, location_id, source, period_year, period_month, filename, total_rows, mapped_rows, unmapped_rows, total_overage_amount, total_with_gst, status, imported_at, confirmed_at, voided_at, location:locations!service_usage_imports_location_id_fkey(id, name, code)",
      { count: "exact" }
    )
    .order("imported_at", { ascending: false });

  if (locationId) query = query.eq("location_id", locationId);
  if (year)       query = query.eq("period_year",  parseInt(year));
  if (month)      query = query.eq("period_month", parseInt(month));

  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

// ---------------------------------------------------------------------------
// POST — upload + preview
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin, Manager or Accounts access required" }, { status: 403 });
  }

  // ── 1. Parse multipart form ──────────────────────────────────────────────
  const form = await request.formData();
  const file        = form.get("file");
  const locationId  = form.get("location_id") as string | null;
  const periodYear  = parseInt((form.get("period_year")  as string) || "0");
  const periodMonth = parseInt((form.get("period_month") as string) || "0");

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }
  if (!periodYear || !periodMonth || periodMonth < 1 || periodMonth > 12) {
    return NextResponse.json({ error: "Valid period_year and period_month (1-12) are required" }, { status: 400 });
  }

  const fileObj  = file as File;
  const fileName = fileObj.name || "report.csv";
  const lower    = fileName.toLowerCase();

  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    return NextResponse.json({ error: "Upload a .csv, .xlsx or .xls file" }, { status: 400 });
  }
  if (fileObj.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 400 });
  }

  // ── 2. Fetch location print template ────────────────────────────────────
  const { data: template } = await supabase
    .from("location_print_templates")
    .select("*")
    .eq("location_id", locationId)
    .maybeSingle();

  if (!template) {
    return NextResponse.json(
      { error: "No print template configured for this location. Set one up in Location Settings before importing." },
      { status: 400 }
    );
  }

  // ── 3. Fetch service catalog (BW + Colour rows) ──────────────────────────
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug, name, printer_column, default_overage_rate, gst_rate")
    .in("printer_column", ["bw", "colour"])
    .eq("is_active", true);

  const bwService     = services?.find((s) => s.printer_column === "bw")     || null;
  const colourService = services?.find((s) => s.printer_column === "colour") || null;

  // ── 4. Fetch all active contracts at this location that have a dept ID ──
  const { data: contractRows } = await supabase
    .from("contracts")
    .select(
      "id, contract_number, department_id, lead_id, status, end_date, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)"
    )
    .eq("location_id", locationId)
    .in("status", ["active", "renewal_in_progress"])
    .not("department_id", "is", null);

  // Build dept_id → contract map (lowercase for case-insensitive match)
  const contractByDept = new Map<
    string,
    {
      id: string;
      contract_number: string;
      department_id: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lead: any;
    }
  >();
  for (const c of (contractRows || []).filter(isContractOperational)) {
    if (c.department_id) {
      contractByDept.set(String(c.department_id).toLowerCase().trim(), c);
    }
  }

  // ── 5. Fetch service quotas for all matched contracts ───────────────────
  const contractIds = Array.from(contractByDept.values()).map((c) => c.id);
  type QuotaRow = { contract_id: string; service_id: string; monthly_quota: number; overage_rate: number };
  let quotaRows: QuotaRow[] = [];

  if (contractIds.length > 0) {
    const { data: qr } = await supabase
      .from("contract_service_quotas")
      .select("contract_id, service_id, monthly_quota, overage_rate")
      .in("contract_id", contractIds);
    quotaRows = (qr || []) as QuotaRow[];
  }

  // Build (contractId, serviceId) → quota lookup
  const quotaMap = new Map<string, QuotaRow>();
  for (const q of quotaRows) {
    quotaMap.set(`${q.contract_id}::${q.service_id}`, q);
  }

  // ── 6. Parse CSV ─────────────────────────────────────────────────────────
  const csvText = await fileObj.text();

  // Papa.parse with header:false gives raw arrays so we can use column indices
  const parsed = Papa.parse<string[]>(csvText, {
    header:       false,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  const allRows: string[][] = parsed.data as string[][];
  const headerRows  = Number(template.header_rows  || 3);
  const dataRows    = allRows.slice(headerRows); // skip header rows

  // Column indices from template
  const deptIdIdx       = colLetterToIndex(template.dept_id_col);
  const bwTotalIdx      = template.bw_total_col     ? colLetterToIndex(template.bw_total_col)     : null;
  const colourTotalIdx  = template.colour_total_col ? colLetterToIndex(template.colour_total_col) : null;

  // Department IDs to ignore (system printers, catch-all accounts)
  const ignoreDepts = new Set(
    (template.ignore_dept_ids || []).map((d: string) => d.toLowerCase().trim())
  );

  // ── 7. Build preview rows ────────────────────────────────────────────────
  const previewRows: ServiceImportPreviewRow[] = [];
  let totalOverageAmount = 0;
  let totalWithGst       = 0;
  let mappedCount        = 0;
  let unmappedCount      = 0;

  for (const row of dataRows) {
    const rawDeptId = String(row[deptIdIdx] ?? "").trim();
    if (!rawDeptId) continue; // skip empty rows

    const deptIdLower = rawDeptId.toLowerCase();
    if (ignoreDepts.has(deptIdLower)) continue;

    // Parse usage numbers
    const bwUsed     = bwTotalIdx     !== null ? parseNumeric(row[bwTotalIdx])     : 0;
    const colourUsed = colourTotalIdx !== null ? parseNumeric(row[colourTotalIdx]) : 0;

    // Match to contract
    const contract  = contractByDept.get(deptIdLower) || null;
    const isUnmapped = !contract;

    // Customer name
    const customerName = contract?.lead
      ? (contract.lead.company || `${contract.lead.first_name ?? ""} ${contract.lead.last_name ?? ""}`.trim())
      : null;

    const flags: string[] = [];

    // BW overage
    let bwQuotaContract  = 0;
    let bwOverageQty     = 0;
    let bwOverageAmount  = 0;

    if (!isUnmapped && bwService) {
      const bwQuota = quotaMap.get(`${contract!.id}::${bwService.id}`);
      if (bwQuota) {
        bwQuotaContract = Number(bwQuota.monthly_quota || 0);
        const rate       = Number(bwQuota.overage_rate || bwService.default_overage_rate || 0);
        bwOverageQty     = Math.max(0, bwUsed - bwQuotaContract);
        bwOverageAmount  = parseFloat((bwOverageQty * rate).toFixed(2));
      } else {
        // No quota set — charge everything
        bwQuotaContract = 0;
        const rate       = Number(bwService.default_overage_rate || 0);
        bwOverageQty     = bwUsed;
        bwOverageAmount  = parseFloat((bwOverageQty * rate).toFixed(2));
        if (bwUsed > 0) flags.push("no_bw_quota");
      }
    }

    // Colour overage
    let colourQuotaContract = 0;
    let colourOverageQty    = 0;
    let colourOverageAmount = 0;

    if (!isUnmapped && colourService) {
      const colourQuota = quotaMap.get(`${contract!.id}::${colourService.id}`);
      if (colourQuota) {
        colourQuotaContract = Number(colourQuota.monthly_quota || 0);
        const rate           = Number(colourQuota.overage_rate || colourService.default_overage_rate || 0);
        colourOverageQty     = Math.max(0, colourUsed - colourQuotaContract);
        colourOverageAmount  = parseFloat((colourOverageQty * rate).toFixed(2));
      } else {
        colourQuotaContract = 0;
        const rate           = Number(colourService.default_overage_rate || 0);
        colourOverageQty     = colourUsed;
        colourOverageAmount  = parseFloat((colourOverageQty * rate).toFixed(2));
        if (colourUsed > 0) flags.push("no_colour_quota");
      }
    }

    const rowTotalExGst = bwOverageAmount + colourOverageAmount;
    const gstRate       = bwService?.gst_rate ?? 18;
    const rowGst        = parseFloat((rowTotalExGst * (gstRate / 100)).toFixed(2));
    const rowTotalWithGst = parseFloat((rowTotalExGst + rowGst).toFixed(2));

    if (isUnmapped) {
      unmappedCount++;
    } else {
      mappedCount++;
      totalOverageAmount += rowTotalExGst;
      totalWithGst       += rowTotalWithGst;
    }

    previewRows.push({
      dept_id:             rawDeptId,
      contract_id:         contract?.id         ?? null,
      contract_number:     contract?.contract_number ?? null,
      customer_name:       customerName,
      bw_used:             bwUsed,
      bw_quota_report:     null,  // report doesn't always include quota column
      bw_quota_contract:   bwQuotaContract,
      bw_overage_qty:      bwOverageQty,
      bw_overage_amount:   bwOverageAmount,
      colour_used:         colourUsed,
      colour_quota_report: null,
      colour_quota_contract: colourQuotaContract,
      colour_overage_qty:  colourOverageQty,
      colour_overage_amount: colourOverageAmount,
      total_amount:        rowTotalExGst,
      is_unmapped:         isUnmapped,
      flags:               flags.length > 0 ? flags : undefined,
      raw:                 { row: row.join(",") },
    });
  }

  // ── 8. Upload raw file to storage ────────────────────────────────────────
  const ext      = lower.split(".").pop() || "csv";
  const filePath = `imports/${locationId}/${periodYear}-${String(periodMonth).padStart(2, "0")}/${Date.now()}.${ext}`;
  const buf      = Buffer.from(await fileObj.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from("service-imports")
    .upload(filePath, buf, {
      contentType: fileObj.type || "text/csv",
      upsert: false,
    });

  if (upErr) {
    return NextResponse.json({ error: `File upload failed: ${upErr.message}` }, { status: 500 });
  }

  // ── 9. Save import record (status = "preview") ───────────────────────────
  const { data: importRecord, error: insertErr } = await supabase
    .from("service_usage_imports")
    .insert({
      location_id:          locationId,
      source:               "printer_report",
      period_year:          periodYear,
      period_month:         periodMonth,
      filename:             fileName,
      file_path:            filePath,
      file_size_bytes:      fileObj.size,
      total_rows:           previewRows.length,
      mapped_rows:          mappedCount,
      unmapped_rows:        unmappedCount,
      total_overage_amount: parseFloat(totalOverageAmount.toFixed(2)),
      total_with_gst:       parseFloat(totalWithGst.toFixed(2)),
      status:               "preview",
      imported_by:          dbUser.id,
      imported_at:          new Date().toISOString(),
      preview_rows:         previewRows,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Clean up uploaded file on DB failure
    await supabase.storage.from("service-imports").remove([filePath]);
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data: importRecord }, { status: 201 });
}
