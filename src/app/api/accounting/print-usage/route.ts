/**
 * POST /api/accounting/print-usage
 *
 * Manual print usage entry — records B&W and colour page counts for a specific
 * contract and billing period. Computes overage against the contract's service
 * quotas and upserts into service_usage_records (source='manual').
 *
 * Each call for the same (contract, service, period) replaces the previous
 * manual record — safe to re-enter corrections.
 *
 * GET /api/accounting/print-usage?contract_id=...
 * Returns existing manual entries for a contract so the dialog can pre-fill.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const ALLOWED_ROLES = ["admin", "accounts", "manager"];

const entrySchema = z.object({
  contract_id:  z.string().uuid(),
  period_year:  z.number().int().min(2020).max(2100),
  period_month: z.number().int().min(1).max(12),
  bw_used:      z.number().min(0),
  colour_used:  z.number().min(0),
  notes:        z.string().max(500).optional(),
});

// ── GET ──────────────────────────────────────────────────────────────────────
// Returns existing manual entries for the given contract so the dialog can
// pre-fill values for the selected month.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const contractId  = searchParams.get("contract_id");
  const periodYear  = searchParams.get("period_year");
  const periodMonth = searchParams.get("period_month");

  if (!contractId) return NextResponse.json({ error: "contract_id required" }, { status: 400 });

  // Fetch existing manual entries and catalog rates in parallel.
  // catalogRates lets the dialog show live cost estimates even when the
  // contract has no configured quota rows (all usage is billed at the
  // centre's standard rate in that case).
  let query = supabase
    .from("service_usage_records")
    .select("id, service_id, period_year, period_month, quantity_used, quota_snapshot, overage_quantity, overage_rate_snapshot, amount, source, notes, created_at")
    .eq("contract_id", contractId)
    .eq("source", "manual")
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false });

  if (periodYear)  query = query.eq("period_year",  parseInt(periodYear));
  if (periodMonth) query = query.eq("period_month", parseInt(periodMonth));

  const [{ data, error }, { data: catalogServices }] = await Promise.all([
    query,
    supabase
      .from("service_catalog")
      .select("printer_column, default_overage_rate")
      .in("printer_column", ["bw", "colour"])
      .eq("is_active", true),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const catalogRates = {
    bw:     catalogServices?.find(s => s.printer_column === "bw")?.default_overage_rate     ?? 0,
    colour: catalogServices?.find(s => s.printer_column === "colour")?.default_overage_rate ?? 0,
  };

  return NextResponse.json({ data: data || [], catalogRates });
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin, Manager, or Accounts access required" }, { status: 403 });
  }

  const body = await request.json();
  const result = entrySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues.map(i => i.message).join("; ") }, { status: 400 });
  }

  const { contract_id, period_year, period_month, bw_used, colour_used, notes } = result.data;

  // ── 1. Validate contract ──────────────────────────────────────────────────
  const { data: contract, error: contractErr } = await supabase
    .from("contracts")
    .select("id, location_id, status, lead_id")
    .eq("id", contract_id)
    .single();

  if (contractErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (contract.status !== "active") {
    return NextResponse.json({ error: "Print usage can only be entered for active contracts" }, { status: 400 });
  }
  if (!contract.location_id) {
    return NextResponse.json({ error: "Contract has no location — cannot record print usage" }, { status: 400 });
  }

  // ── 2. Fetch BW and Colour service catalog items ──────────────────────────
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug, name, printer_column, default_overage_rate, gst_rate")
    .in("printer_column", ["bw", "colour"])
    .eq("is_active", true);

  const bwService     = services?.find(s => s.printer_column === "bw")     ?? null;
  const colourService = services?.find(s => s.printer_column === "colour") ?? null;

  if (!bwService && bw_used > 0) {
    return NextResponse.json({ error: "No B&W print service configured in the service catalog" }, { status: 400 });
  }
  if (!colourService && colour_used > 0) {
    return NextResponse.json({ error: "No Colour print service configured in the service catalog" }, { status: 400 });
  }

  // ── 3. Fetch this contract's service quotas ───────────────────────────────
  const serviceIds = [bwService?.id, colourService?.id].filter(Boolean) as string[];
  const { data: quotaRows } = await supabase
    .from("contract_service_quotas")
    .select("service_id, monthly_quota, overage_rate")
    .eq("contract_id", contract_id)
    .in("service_id", serviceIds);

  const quotaByService = new Map(quotaRows?.map(q => [q.service_id, q]) ?? []);

  // ── 4. Compute and upsert records ─────────────────────────────────────────
  const results: Array<{
    service: string;
    quantity_used: number;
    quota: number;
    overage_quantity: number;
    amount: number;
  }> = [];

  const recordsToUpsert: Array<Record<string, unknown>> = [];

  const processService = (
    service: { id: string; name: string; default_overage_rate: number; gst_rate: number } | null,
    quantityUsed: number,
    serviceLabel: string,
  ) => {
    if (!service || quantityUsed === 0) return;

    const quota  = quotaByService.get(service.id);
    const monthlyQuota   = Number(quota?.monthly_quota ?? 0);
    const overageRate    = Number(quota?.overage_rate ?? service.default_overage_rate ?? 0);
    const overageQty     = Math.max(0, quantityUsed - monthlyQuota);
    const amount         = parseFloat((overageQty * overageRate).toFixed(2));
    const gstRate        = Number(service.gst_rate ?? 18);
    const gstAmount      = parseFloat((amount * gstRate / 100).toFixed(2));
    const totalWithGst   = parseFloat((amount + gstAmount).toFixed(2));

    recordsToUpsert.push({
      contract_id,
      service_id:           service.id,
      location_id:          contract.location_id,
      period_year,
      period_month,
      quantity_used:        quantityUsed,
      quota_snapshot:       monthlyQuota,
      overage_rate_snapshot: overageRate,
      overage_quantity:     overageQty,
      amount,
      gst_rate:             gstRate,
      gst_amount:           gstAmount,
      total_with_gst:       totalWithGst,
      source:               "manual",
      notes:                notes ?? null,
      created_by:           dbUser.id,
    });

    results.push({ service: serviceLabel, quantity_used: quantityUsed, quota: monthlyQuota, overage_quantity: overageQty, amount });
  };

  processService(bwService, bw_used, "B&W");
  processService(colourService, colour_used, "Colour");

  if (recordsToUpsert.length === 0) {
    return NextResponse.json({ error: "No usage to record (both B&W and colour are 0)" }, { status: 400 });
  }

  // Upsert — if a manual record already exists for this (contract, service, period),
  // replace it so re-entries are safe corrections.
  const { data: upserted, error: upsertErr } = await supabase
    .from("service_usage_records")
    .upsert(recordsToUpsert, { onConflict: "contract_id,service_id,period_year,period_month,source" })
    .select("id, service_id, quantity_used, overage_quantity, amount");

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // ── 5. Audit ──────────────────────────────────────────────────────────────
  for (const rec of upserted || []) {
    logAudit(supabase, {
      entityType: "service_usage_record",
      entityId:   rec.id,
      action:     "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: { contract_id, period_year, period_month, ...rec } } },
    });
  }

  return NextResponse.json({ data: { records: upserted, summary: results } }, { status: 201 });
}
