import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import {
  loadFinanceIntelligenceConfig,
  isFeatureEnabled,
  lookbackCutoff,
  similarity,
  normaliseInvoiceNumber,
  logAndResolve,
} from "@/lib/finance-intelligence";

/**
 * POST /api/procurement/bills/check-duplicate
 *
 * Called by the new-bill form (debounced) as the operator fills in
 * vendor + invoice number + amount. Returns up to 5 candidate duplicate
 * bills with a similarity score + match reason so the form can show a
 * non-blocking warning banner.
 *
 * Logic:
 *   1. Pull recent bills for the same vendor (within lookback window).
 *   2. For each, compute a similarity score on three signals:
 *        a) invoice_number Levenshtein-similarity (weighted 60%)
 *        b) total_amount match within ±₹1            (weighted 25%)
 *        c) invoice_date proximity within ±7 days    (weighted 15%)
 *   3. Threshold at 0.55 — below that it's noise.
 *   4. Always include exact invoice_number matches at any score.
 *   5. Sort by score descending, return top 5.
 *
 * Always logs to finance_suggestion_log (action=shown if duplicates found,
 * else action=ignored) so we can measure precision over time.
 *
 * Roles: anyone authenticated (matches who can create a bill).
 */

const requestSchema = z.object({
  vendor_id: z.string().uuid(),
  invoice_number: z.string().trim().min(1).max(50),
  total_amount: z.number().positive(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exclude_bill_id: z.string().uuid().optional(), // when editing an existing bill, don't match it against itself
});

export interface DuplicateCandidate {
  bill_id: string;
  bill_number: string;
  invoice_number: string | null;
  invoice_date: string;
  total_amount: number;
  vendor_name: string | null;
  approval_status: string;
  similarity_score: number;        // 0..1
  match_reason: string;            // human-readable
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
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  // Feature gate
  const config = await loadFinanceIntelligenceConfig(supabase);
  if (!isFeatureEnabled(config, "duplicate_detector")) {
    return NextResponse.json({ candidates: [], feature_disabled: true });
  }

  // Pull recent bills for the same vendor
  const cutoff = lookbackCutoff(config.lookback_months);
  let q = supabase
    .from("vendor_bills")
    .select(`id, bill_number, invoice_number, invoice_date, total_amount, approval_status,
             procurement_vendors(name)`)
    .eq("vendor_id", input.vendor_id)
    .gte("invoice_date", cutoff.split("T")[0])
    .order("invoice_date", { ascending: false })
    .limit(50);
  if (input.exclude_bill_id) q = q.neq("id", input.exclude_bill_id);

  const { data: history } = await q;
  if (!history?.length) {
    // No baseline at all — log as ignored, return empty
    await logAndResolve(
      supabase,
      {
        feature: "duplicate_detector",
        entity_type: "vendor_bill",
        suggestion: { candidates: [] },
        context: { vendor_id: input.vendor_id, reason: "no_history" },
        triggered_by: dbUser.id,
      },
      "ignored",
    );
    return NextResponse.json({ candidates: [] });
  }

  // Score each candidate
  const inputNormNumber = normaliseInvoiceNumber(input.invoice_number);
  const inputDate = new Date(input.invoice_date);

  const scored: DuplicateCandidate[] = history
    .map((b) => {
      const reasons: string[] = [];
      let score = 0;

      // Signal A: invoice number similarity
      let numScore = 0;
      if (b.invoice_number) {
        numScore = similarity(inputNormNumber, normaliseInvoiceNumber(b.invoice_number));
        if (numScore === 1) reasons.push("Same invoice #");
        else if (numScore >= 0.85) reasons.push(`Similar invoice # (${Math.round(numScore * 100)}%)`);
      }
      score += numScore * 0.60;

      // Signal B: amount match
      const amtDiff = Math.abs(Number(b.total_amount) - input.total_amount);
      let amtScore = 0;
      if (amtDiff <= 1) {
        amtScore = 1;
        reasons.push("Same amount");
      } else if (amtDiff / input.total_amount < 0.01) {
        amtScore = 0.7;
        reasons.push("Nearly same amount");
      }
      score += amtScore * 0.25;

      // Signal C: date proximity
      const dateDiff = Math.abs(
        (new Date(b.invoice_date).getTime() - inputDate.getTime()) / 86_400_000,
      );
      let dateScore = 0;
      if (dateDiff <= 1) {
        dateScore = 1;
        reasons.push("Same day");
      } else if (dateDiff <= 7) {
        dateScore = 1 - (dateDiff - 1) / 6;
        reasons.push(`${Math.round(dateDiff)} day(s) apart`);
      }
      score += dateScore * 0.15;

      const vendor = b.procurement_vendors as { name: string } | { name: string }[] | null;
      const vendorName = Array.isArray(vendor) ? vendor[0]?.name ?? null : vendor?.name ?? null;

      return {
        bill_id: b.id,
        bill_number: b.bill_number,
        invoice_number: b.invoice_number,
        invoice_date: b.invoice_date,
        total_amount: Number(b.total_amount),
        vendor_name: vendorName,
        approval_status: b.approval_status,
        similarity_score: score,
        match_reason: reasons.join(" · "),
      } satisfies DuplicateCandidate;
    })
    .filter((c) => c.similarity_score >= 0.55 || c.match_reason.startsWith("Same invoice #"))
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, 5);

  // Audit log
  await logAndResolve(
    supabase,
    {
      feature: "duplicate_detector",
      entity_type: "vendor_bill",
      suggestion: { candidate_count: scored.length, top_score: scored[0]?.similarity_score ?? 0 },
      context: {
        vendor_id: input.vendor_id,
        invoice_number: input.invoice_number,
        total_amount: input.total_amount,
      },
      triggered_by: dbUser.id,
    },
    scored.length > 0 ? "shown" : "ignored",
  );

  return NextResponse.json({ candidates: scored });
}
