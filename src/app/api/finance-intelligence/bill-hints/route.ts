import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import {
  loadFinanceIntelligenceConfig,
  isFeatureEnabled,
  getRecentBillsForVendor,
  averageNetDays,
  mostFrequent,
  detectAmountAnomaly,
  logSuggestion,
} from "@/lib/finance-intelligence";
import { zodErrorResponse } from "@/lib/validations";

/**
 * POST /api/finance-intelligence/bill-hints
 *
 * Called by the new-bill form (debounced) once vendor + amount + date
 * are populated. Returns up to 4 soft hints in one round-trip so we
 * don't hammer the DB with separate requests per feature.
 *
 * Hints returned (each is null when the feature is disabled or there
 * isn't enough history to make a reliable suggestion):
 *
 *   due_date_suggestion  — "Pay in 30 days" (due_date_learning)
 *   amount_anomaly       — "4.2× the vendor's average" (amount_anomaly)
 *   batch_suggestion     — "Usually paid on 25th" (batch_date_suggestion)
 *   po_cumulative        — "90% of PO consumed after this bill" (po_mismatch_alert)
 *
 * All are informational — nothing blocks the save. Operator can
 * acknowledge, apply, or ignore each hint independently.
 *
 * Suggestion interactions are logged to finance_suggestion_log for
 * effectiveness measurement.
 */

const requestSchema = z.object({
  vendor_id:    z.string().uuid(),
  total_amount: z.number().positive().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  po_id:        z.string().uuid().optional(),
});

export interface DueDateSuggestion {
  date: string;          // YYYY-MM-DD
  net_days: number;      // e.g. 30
  sample_size: number;   // how many bills the median was drawn from
}

export interface AmountAnomalyHint {
  is_anomaly: boolean;
  reason: string;
  ratio: number;
  baseline_average: number;
  baseline_count: number;
}

export interface BatchSuggestion {
  batch_type: "immediate" | "15th" | "25th";
  frequency: number;   // how many of the last N bills used this batch type
  sample_size: number;
}

export interface PoCumulativeHint {
  po_value: number;
  consumed_amount: number;     // sum of existing bills
  new_total: number;           // consumed_amount + this_bill
  remaining_after: number;     // po_value - new_total (can be negative if over)
  consumed_pct: number;        // (new_total / po_value) * 100
  existing_bill_count: number;
  is_warning: boolean;         // true when consumed_pct ≥ 80
  is_over_budget: boolean;     // true when new_total > po_value
}

export interface BillHintsResponse {
  due_date_suggestion: DueDateSuggestion | null;
  amount_anomaly: AmountAnomalyHint | null;
  batch_suggestion: BatchSuggestion | null;
  po_cumulative: PoCumulativeHint | null;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }
  const input = parsed.data;

  const config = await loadFinanceIntelligenceConfig(supabase);

  // Fire all data-fetching in parallel
  const [history, poData] = await Promise.all([
    // Only fetch if FI is enabled at all
    config.enabled
      ? getRecentBillsForVendor(supabase, input.vendor_id, {
          lookbackMonths: config.lookback_months,
          limit: 20,
        })
      : Promise.resolve([]),
    // Only fetch PO data if po_id supplied and po_mismatch feature on
    input.po_id && isFeatureEnabled(config, "po_mismatch_alert")
      ? supabase
          .from("purchase_orders")
          .select("id, total_ordered_amount")
          .eq("id", input.po_id)
          .single()
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);

  const result: BillHintsResponse = {
    due_date_suggestion: null,
    amount_anomaly: null,
    batch_suggestion: null,
    po_cumulative: null,
  };

  // ── 1. Due-date suggestion (due_date_learning) ──────────────────────────────
  if (
    isFeatureEnabled(config, "due_date_learning") &&
    input.invoice_date &&
    history.length >= 2
  ) {
    const netDays = averageNetDays(history);
    if (netDays !== null && netDays > 0) {
      const base = new Date(input.invoice_date);
      base.setDate(base.getDate() + netDays);
      const suggestedDate = base.toISOString().split("T")[0];
      result.due_date_suggestion = {
        date: suggestedDate,
        net_days: netDays,
        sample_size: history.filter((b) => b.due_date).length,
      };

      // Log (fire-and-forget — don't await in the hot path)
      logSuggestion(supabase, {
        feature: "due_date_learning",
        entity_type: "vendor_bill",
        suggestion: { date: suggestedDate, net_days: netDays },
        context: { vendor_id: input.vendor_id, invoice_date: input.invoice_date },
        triggered_by: dbUser.id,
      }).catch(() => {});
    }
  }

  // ── 2. Amount anomaly (amount_anomaly) ──────────────────────────────────────
  if (
    isFeatureEnabled(config, "amount_anomaly") &&
    input.total_amount &&
    history.length >= 3
  ) {
    const amounts = history.map((b) => Number(b.total_amount));
    const anomaly = detectAmountAnomaly(input.total_amount, amounts);
    // Always return the result so the UI knows whether to show/hide the hint
    result.amount_anomaly = {
      is_anomaly: anomaly.is_anomaly,
      reason: anomaly.reason ?? "",
      ratio: anomaly.ratio ?? input.total_amount / (anomaly.baseline_average ?? 1),
      baseline_average: anomaly.baseline_average ?? 0,
      baseline_count: anomaly.baseline_count ?? history.length,
    };

    if (anomaly.is_anomaly) {
      logSuggestion(supabase, {
        feature: "amount_anomaly",
        entity_type: "vendor_bill",
        suggestion: {
          reason: anomaly.reason,
          ratio: anomaly.ratio,
          baseline_average: anomaly.baseline_average,
        },
        context: {
          vendor_id: input.vendor_id,
          total_amount: input.total_amount,
          baseline_count: anomaly.baseline_count,
        },
        triggered_by: dbUser.id,
      }).catch(() => {});
    }
  }

  // ── 3. Batch-date suggestion (batch_date_suggestion) ───────────────────────
  if (
    isFeatureEnabled(config, "batch_date_suggestion") &&
    history.length >= 2
  ) {
    const batchTypes = history.map((b) => b.payment_batch_type);
    const topBatch = mostFrequent(batchTypes.filter(Boolean) as string[]);
    if (topBatch && ["immediate", "15th", "25th"].includes(topBatch)) {
      const freq = batchTypes.filter((t) => t === topBatch).length;
      result.batch_suggestion = {
        batch_type: topBatch as "immediate" | "15th" | "25th",
        frequency: freq,
        sample_size: batchTypes.filter(Boolean).length,
      };

      logSuggestion(supabase, {
        feature: "batch_date_suggestion",
        entity_type: "vendor_bill",
        suggestion: { batch_type: topBatch, frequency: freq },
        context: { vendor_id: input.vendor_id },
        triggered_by: dbUser.id,
      }).catch(() => {});
    }
  }

  // ── 4. PO cumulative warning (po_mismatch_alert) ────────────────────────────
  if (
    isFeatureEnabled(config, "po_mismatch_alert") &&
    input.po_id &&
    input.total_amount &&
    poData
  ) {
    const poValue = Number(poData.total_ordered_amount);
    if (poValue > 0) {
      // Sum all existing approved/pending bills for this PO (exclude rejected)
      const { data: existingBills } = await supabase
        .from("vendor_bills")
        .select("total_amount")
        .eq("po_id", input.po_id)
        .not("approval_status", "eq", "rejected");

      const consumed = (existingBills ?? []).reduce(
        (s, b) => s + Number(b.total_amount), 0,
      );
      const newTotal = consumed + input.total_amount;
      const remaining = poValue - newTotal;
      const pct = Math.round((newTotal / poValue) * 100);

      result.po_cumulative = {
        po_value: poValue,
        consumed_amount: consumed,
        new_total: newTotal,
        remaining_after: remaining,
        consumed_pct: pct,
        existing_bill_count: (existingBills ?? []).length,
        is_warning: pct >= 80,
        is_over_budget: newTotal > poValue,
      };

      if (pct >= 80) {
        logSuggestion(supabase, {
          feature: "po_mismatch_alert",
          entity_type: "vendor_bill",
          suggestion: { consumed_pct: pct, remaining_after: remaining },
          context: {
            po_id: input.po_id,
            po_value: poValue,
            consumed_amount: consumed,
            new_bill_amount: input.total_amount,
          },
          triggered_by: dbUser.id,
        }).catch(() => {});
      }
    }
  }

  return NextResponse.json(result);
}
