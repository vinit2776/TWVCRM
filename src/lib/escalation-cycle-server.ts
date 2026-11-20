import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCycleSchedule,
  cycleToPhases,
  isEscalationCycle,
  type CycleStep,
} from "@/lib/escalation-cycle";
import { hasFixedLines } from "@/lib/line-item-escalation";

/** Statuses in which a contract's price or dates can still legitimately move. */
const OPEN_STATUSES = ["draft", "sent", "viewed", "accepted"];

export interface CycleContractFields {
  status: string;
  start_date: string | null;
  end_date: string | null;
  phase_start_date: string | null;
  subtotal: number | string | null;
  total_amount: number | string | null;
  escalation_percentage: number | string | null;
  escalation_cycle_months: number | null;
  items: Array<{ escalates?: boolean }> | null;
}

export type CyclePlan =
  | { kind: "none" } // no cycle on this contract: leave phases alone
  | { kind: "locked" } // activated or later: the schedule is part of what was signed
  | { kind: "blocked"; error: string }
  | { kind: "build"; steps: CycleStep[]; cycleMonths: number };

export const CYCLE_FIXED_LINES_ERROR =
  "An escalation cycle can't be used when a line is marked fixed (for example maintenance that does not escalate). Turn the cycle off, or make every line escalate.";

/** Pure: what the stored phases should become for this contract. */
export function planCyclePhases(c: CycleContractFields, activating = false): CyclePlan {
  if (!isEscalationCycle(c.escalation_cycle_months)) return { kind: "none" };
  if (!activating && !OPEN_STATUSES.includes(c.status)) return { kind: "locked" };
  if (hasFixedLines(c.items)) return { kind: "blocked", error: CYCLE_FIXED_LINES_ERROR };
  const anchor = c.phase_start_date || c.start_date;
  if (!anchor || !c.end_date) return { kind: "build", steps: [], cycleMonths: c.escalation_cycle_months };
  const steps = buildCycleSchedule({
    anchorYmd: anchor,
    endYmd: c.end_date,
    baseRate: Number(c.subtotal || c.total_amount || 0),
    percent: Number(c.escalation_percentage ?? 0),
    cycleMonths: c.escalation_cycle_months,
  });
  return { kind: "build", steps, cycleMonths: c.escalation_cycle_months };
}

export type CycleSyncResult = { ok: true; steps: CycleStep[]; changed: boolean } | { ok: false; error: string };

/**
 * Makes contract_rate_phases match the contract's escalation cycle. Called by
 * every writer that can move the start, end, fee or percentage, so the stored
 * schedule (which billing, the agreement and the addendum all read) never drifts
 * from the contract. Not best-effort: a failure is returned so the caller can
 * say so, because a stale schedule would bill the wrong amount.
 */
export async function syncCyclePhases(
  admin: SupabaseClient,
  contractId: string,
  opts: { activating?: boolean } = {},
): Promise<CycleSyncResult> {
  const { data: c, error } = await admin
    .from("contracts")
    .select("status, start_date, end_date, phase_start_date, subtotal, total_amount, escalation_percentage, escalation_cycle_months, items")
    .eq("id", contractId)
    .single();
  if (error || !c) return { ok: false, error: error?.message ?? "Contract not found" };

  const plan = planCyclePhases(c as CycleContractFields, opts.activating);
  if (plan.kind === "none" || plan.kind === "locked") return { ok: true, steps: [], changed: false };
  if (plan.kind === "blocked") return { ok: false, error: plan.error };

  const wanted = cycleToPhases(plan.steps, plan.cycleMonths);
  const { data: existing, error: readErr } = await admin
    .from("contract_rate_phases")
    .select("phase_order, duration_months, monthly_rate, end_date")
    .eq("contract_id", contractId)
    .order("phase_order");
  if (readErr) return { ok: false, error: readErr.message };

  const same =
    (existing ?? []).length === wanted.length &&
    (existing ?? []).every((p, i) =>
      p.phase_order === wanted[i].phase_order &&
      Number(p.monthly_rate) === wanted[i].monthly_rate &&
      (p.end_date ?? null) === (wanted[i].end_date ?? null));
  if (same) return { ok: true, steps: plan.steps, changed: false };

  const { error: delErr } = await admin.from("contract_rate_phases").delete().eq("contract_id", contractId);
  if (delErr) return { ok: false, error: delErr.message };
  if (wanted.length > 0) {
    const { error: insErr } = await admin.from("contract_rate_phases").insert(
      wanted.map((p) => ({
        contract_id: contractId,
        phase_order: p.phase_order,
        duration_months: p.duration_months,
        monthly_rate: p.monthly_rate,
        end_date: p.end_date ?? null,
      })),
    );
    if (insErr) return { ok: false, error: insErr.message };
  }
  return { ok: true, steps: plan.steps, changed: true };
}

/**
 * The fee a renewal of this contract starts from when the contract stepped inside
 * its term: the last stepped fee. Null when it never stepped (no cycle, or a term
 * no longer than one cycle), in which case the renewal escalates the usual way.
 */
export async function lastCycleFee(
  admin: SupabaseClient,
  contract: { id: string; escalation_cycle_months?: number | null },
): Promise<number | null> {
  if (!isEscalationCycle(contract.escalation_cycle_months)) return null;
  const { data: phases } = await admin
    .from("contract_rate_phases")
    .select("phase_order, monthly_rate")
    .eq("contract_id", contract.id)
    .order("phase_order", { ascending: false });
  return (phases?.length ?? 0) > 1 ? Number(phases![0].monthly_rate) : null;
}
