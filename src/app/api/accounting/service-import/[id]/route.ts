/**
 * /api/accounting/service-import/[id]
 *
 * GET    — fetch a single import with full preview_rows
 * POST   — confirm: create service_usage_records + usage_charges for all
 *           mapped, non-excluded rows; mark import status = "confirmed"
 * DELETE — void an import (status = "voided")
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import type { ServiceImportPreviewRow } from "@/types";

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("service_usage_imports")
    .select(
      "*, location:locations!service_usage_imports_location_id_fkey(id, name, code)"
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Import not found" }, { status: 404 });
  return NextResponse.json({ data });
}

// ---------------------------------------------------------------------------
// POST — confirm
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  // Fetch the import
  const { data: importRecord, error: fetchErr } = await supabase
    .from("service_usage_imports")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !importRecord) {
    return NextResponse.json({ error: "Import not found" }, { status: 404 });
  }
  if (importRecord.status !== "preview") {
    return NextResponse.json(
      { error: `Import is already "${importRecord.status}" — only preview imports can be confirmed` },
      { status: 400 }
    );
  }

  // Caller may pass exclusions: { [dept_id]: true } = skip this row
  const body = await request.json().catch(() => ({}));
  const exclusions: Record<string, boolean> = body.exclusions || {};

  // Fetch service catalog (BW + Colour)
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug, printer_column, default_overage_rate, gst_rate")
    .in("printer_column", ["bw", "colour"])
    .eq("is_active", true);

  const bwService     = services?.find((s) => s.printer_column === "bw")     || null;
  const colourService = services?.find((s) => s.printer_column === "colour") || null;

  const previewRows = (importRecord.preview_rows as ServiceImportPreviewRow[]) || [];
  const locationId  = importRecord.location_id as string;
  const periodYear  = importRecord.period_year  as number;
  const periodMonth = importRecord.period_month as number;

  // Collect unique contract IDs we'll need data for
  const contractIds = [
    ...new Set(
      previewRows
        .filter((r) => !r.is_unmapped && r.contract_id)
        .map((r) => r.contract_id as string)
    ),
  ];

  // Fetch lead_ids for all contracts (required by usage_charges.lead_id NOT NULL)
  const leadByContract = new Map<string, string>();
  if (contractIds.length > 0) {
    const { data: contractRows } = await supabase
      .from("contracts")
      .select("id, lead_id")
      .in("id", contractIds);
    for (const c of contractRows || []) {
      if (c.lead_id) leadByContract.set(c.id, c.lead_id);
    }
  }

  // Fetch service quotas
  type QuotaRow = { contract_id: string; service_id: string; monthly_quota: number; overage_rate: number };
  let quotaRows: QuotaRow[] = [];
  if (contractIds.length > 0 && (bwService || colourService)) {
    const serviceIds = [bwService?.id, colourService?.id].filter(Boolean) as string[];
    const { data: qr } = await supabase
      .from("contract_service_quotas")
      .select("contract_id, service_id, monthly_quota, overage_rate")
      .in("contract_id", contractIds)
      .in("service_id", serviceIds);
    quotaRows = (qr || []) as QuotaRow[];
  }
  const quotaMap = new Map<string, QuotaRow>();
  for (const q of quotaRows) {
    quotaMap.set(`${q.contract_id}::${q.service_id}`, q);
  }

  // ── Build records to insert ──────────────────────────────────────────────
  const usageRecordsToInsert: Record<string, unknown>[] = [];
  const usageChargesToInsert: Record<string, unknown>[] = [];

  for (const row of previewRows) {
    if (row.is_unmapped)           continue;
    if (row.is_excluded)           continue;
    if (exclusions[row.dept_id])   continue;
    if (!row.contract_id)          continue;

    const contractId = row.contract_id;
    const leadId     = leadByContract.get(contractId);
    if (!leadId) continue; // safety: can't create usage_charge without lead

    // ── BW ────────────────────────────────────────────────────────────────
    if (bwService && row.bw_used > 0) {
      const quota      = quotaMap.get(`${contractId}::${bwService.id}`);
      const rate       = quota ? Number(quota.overage_rate) : Number(bwService.default_overage_rate);
      const quotaQty   = quota ? Number(quota.monthly_quota) : 0;
      const overageQty = Math.max(0, row.bw_used - quotaQty);
      const amount     = parseFloat((overageQty * rate).toFixed(2));
      const gstRate    = Number(bwService.gst_rate || 18);
      const gstAmount  = parseFloat((amount * gstRate / 100).toFixed(2));

      usageRecordsToInsert.push({
        contract_id:           contractId,
        service_id:            bwService.id,
        location_id:           locationId,
        period_year:           periodYear,
        period_month:          periodMonth,
        quantity_used:         row.bw_used,
        quota_snapshot:        quotaQty,
        overage_rate_snapshot: rate,
        overage_quantity:      overageQty,
        amount,
        gst_rate:              gstRate,
        gst_amount:            gstAmount,
        total_with_gst:        parseFloat((amount + gstAmount).toFixed(2)),
        source:                "printer_report",
        source_ref:            id,
        detail:                { dept_id: row.dept_id },
        is_billed:             false,
        created_by:            dbUser.id,
      });

      if (overageQty > 0) {
        const periodLabel = `${periodYear}/${String(periodMonth).padStart(2, "0")}`;
        usageChargesToInsert.push({
          contract_id: contractId,
          lead_id:     leadId,
          description: `B&W Print Overage: ${overageQty} pages (${periodLabel})`,
          quantity:    overageQty,
          unit_price:  rate,
          total:       amount,
          charge_date: `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`,
          status:      "pending",
          notes:       `Import ID: ${id}`,
          created_by:  dbUser.id,
        });
      }
    }

    // ── Colour ────────────────────────────────────────────────────────────
    if (colourService && row.colour_used > 0) {
      const quota      = quotaMap.get(`${contractId}::${colourService.id}`);
      const rate       = quota ? Number(quota.overage_rate) : Number(colourService.default_overage_rate);
      const quotaQty   = quota ? Number(quota.monthly_quota) : 0;
      const overageQty = Math.max(0, row.colour_used - quotaQty);
      const amount     = parseFloat((overageQty * rate).toFixed(2));
      const gstRate    = Number(colourService.gst_rate || 18);
      const gstAmount  = parseFloat((amount * gstRate / 100).toFixed(2));

      usageRecordsToInsert.push({
        contract_id:           contractId,
        service_id:            colourService.id,
        location_id:           locationId,
        period_year:           periodYear,
        period_month:          periodMonth,
        quantity_used:         row.colour_used,
        quota_snapshot:        quotaQty,
        overage_rate_snapshot: rate,
        overage_quantity:      overageQty,
        amount,
        gst_rate:              gstRate,
        gst_amount:            gstAmount,
        total_with_gst:        parseFloat((amount + gstAmount).toFixed(2)),
        source:                "printer_report",
        source_ref:            id,
        detail:                { dept_id: row.dept_id },
        is_billed:             false,
        created_by:            dbUser.id,
      });

      if (overageQty > 0) {
        const periodLabel = `${periodYear}/${String(periodMonth).padStart(2, "0")}`;
        usageChargesToInsert.push({
          contract_id: contractId,
          lead_id:     leadId,
          description: `Colour Print Overage: ${overageQty} pages (${periodLabel})`,
          quantity:    overageQty,
          unit_price:  rate,
          total:       amount,
          charge_date: `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`,
          status:      "pending",
          notes:       `Import ID: ${id}`,
          created_by:  dbUser.id,
        });
      }
    }
  }

  // Upsert service_usage_records (idempotent on contract+service+period+source)
  if (usageRecordsToInsert.length > 0) {
    const { error: surErr } = await supabase
      .from("service_usage_records")
      .upsert(usageRecordsToInsert, {
        onConflict: "contract_id,service_id,period_year,period_month,source",
        ignoreDuplicates: false,
      });

    if (surErr) {
      return NextResponse.json({ error: `Failed to save usage records: ${surErr.message}` }, { status: 500 });
    }
  }

  // Insert usage_charges (one per overage row)
  if (usageChargesToInsert.length > 0) {
    const { error: ucErr } = await supabase
      .from("usage_charges")
      .insert(usageChargesToInsert);

    if (ucErr) {
      return NextResponse.json({ error: `Failed to create usage charges: ${ucErr.message}` }, { status: 500 });
    }
  }

  // Mark import as confirmed
  const { data: updated, error: updateErr } = await supabase
    .from("service_usage_imports")
    .update({
      status:       "confirmed",
      confirmed_by: dbUser.id,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "service_usage_import",
    entityId:   id,
    action:     "update",
    performedBy: dbUser.id,
    changes: {
      status:                  { old: "preview",  new: "confirmed" },
      service_records_created: { old: null, new: usageRecordsToInsert.length },
      usage_charges_created:   { old: null, new: usageChargesToInsert.length },
    },
  });

  return NextResponse.json({
    data: updated,
    summary: {
      service_records_created: usageRecordsToInsert.length,
      usage_charges_created:   usageChargesToInsert.length,
    },
  });
}

// ---------------------------------------------------------------------------
// DELETE — void
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = (body.reason as string) || null;

  const { data: importRecord } = await supabase
    .from("service_usage_imports")
    .select("id, status")
    .eq("id", id)
    .single();

  if (!importRecord) {
    return NextResponse.json({ error: "Import not found" }, { status: 404 });
  }
  if (importRecord.status === "voided") {
    return NextResponse.json({ error: "Import is already voided" }, { status: 400 });
  }

  const { data: updated, error: updateErr } = await supabase
    .from("service_usage_imports")
    .update({
      status:        "voided",
      voided_by:     dbUser.id,
      voided_at:     new Date().toISOString(),
      voided_reason: reason,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "service_usage_import",
    entityId:   id,
    action:     "update",
    performedBy: dbUser.id,
    changes: {
      status:        { old: importRecord.status, new: "voided" },
      voided_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: updated });
}
