import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGstAndRounding } from "@/lib/gst-math";
import {
  applyAddonChange,
  monthWindow,
  type AddonTerms,
  type StatementSection,
} from "@/lib/addon-billing";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StatementRef {
  statement_number: string | null;
  period_start: string;
  period_end: string;
  status: string;
}

export interface AddonSyncReport {
  /** Unsent drafts that were corrected to match the new add-on terms. */
  updated: StatementRef[];
  /** Unsent drafts a person has to check: a cycle spanning months, or no rent section. */
  needsReview: StatementRef[];
  /** Invoices already issued that this change touches. They are never edited. */
  issued: StatementRef[];
}

export const EMPTY_SYNC_REPORT: AddonSyncReport = { updated: [], needsReview: [], issued: [] };

/**
 * After an add-on is added, edited, paused or ended, bring the contract's
 * statements in line. An unsent single-month draft is corrected in place, with
 * the line and the GST recomputed. Anything already issued is left alone and
 * reported, so the person making the change can see what the customer was
 * already billed. Failures are logged and reported as "needs review": the
 * add-on change itself has already been saved and must not look failed.
 */
export async function syncStatementsForAddonChange(
  admin: SupabaseClient,
  contractId: string,
  before: AddonTerms | null,
  after: AddonTerms | null
): Promise<AddonSyncReport> {
  const report: AddonSyncReport = { updated: [], needsReview: [], issued: [] };
  const dates = [before, after].filter((a): a is AddonTerms => !!a);
  if (dates.length === 0) return report;

  const lo = dates.map((a) => a.effective_from).sort()[0];
  const hi = dates.some((a) => !a.effective_until) ? "9999-12-31" : dates.map((a) => a.effective_until as string).sort().reverse()[0];

  try {
    const { data: statements, error } = await admin
      .from("billing_statements")
      .select("id, statement_number, status, proforma_sent_at, period_start, period_end, subtotal, fixed_amount, tax_percentage, line_items")
      .eq("contract_id", contractId)
      .eq("statement_type", "rent")
      .neq("status", "voided")
      .gte("period_end", lo)
      .lte("period_start", hi);
    if (error) throw new Error(error.message);

    for (const stmt of statements ?? []) {
      const ref: StatementRef = {
        statement_number: (stmt.statement_number as string | null) ?? null,
        period_start: stmt.period_start as string,
        period_end: stmt.period_end as string,
        status: stmt.status as string,
      };
      const unsent = stmt.status === "draft" && !stmt.proforma_sent_at;
      const singleMonth = (stmt.period_start as string).slice(0, 7) === (stmt.period_end as string).slice(0, 7);

      if (!singleMonth) {
        (unsent ? report.needsReview : report.issued).push(ref);
        continue;
      }

      const sections = (stmt.line_items as StatementSection[] | null) ?? [];
      const result = applyAddonChange(sections, before, after, monthWindow(stmt.period_start as string));
      if (!result.removed && !result.added && result.placed) continue;

      if (!unsent) {
        report.issued.push(ref);
        continue;
      }
      if (!result.placed) {
        report.needsReview.push(ref);
        continue;
      }

      const subtotal = round2(Number(stmt.subtotal ?? 0) + result.delta);
      const gst = computeGstAndRounding(subtotal, Number(stmt.tax_percentage ?? 18));
      const { error: updateError } = await admin
        .from("billing_statements")
        .update({
          subtotal,
          fixed_amount: round2(Number(stmt.fixed_amount ?? 0) + result.delta),
          tax_amount: gst.taxAmount,
          cgst_amount: gst.cgst,
          sgst_amount: gst.sgst,
          igst_amount: 0,
          total_amount: gst.totalAmount,
          line_items: result.sections,
        })
        .eq("id", stmt.id)
        .eq("status", "draft")
        .is("proforma_sent_at", null);
      if (updateError) throw new Error(updateError.message);
      report.updated.push(ref);
    }
  } catch (err) {
    console.error("[contract-addons] Failed to bring statements in line:", err instanceof Error ? err.message : err);
    report.needsReview.push({ statement_number: null, period_start: lo, period_end: hi, status: "unknown" });
  }

  return report;
}

/** What to tell the person who just changed an add-on, or null when nothing needs saying. */
export function describeSyncReport(report: AddonSyncReport): string | null {
  const label = (r: StatementRef) => r.statement_number ?? `${r.period_start} to ${r.period_end}`;
  const parts: string[] = [];
  if (report.issued.length > 0) {
    parts.push(`Already issued, not changed: ${report.issued.map(label).join(", ")}.`);
  }
  if (report.needsReview.length > 0) {
    parts.push(`Check by hand: ${report.needsReview.map(label).join(", ")}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
