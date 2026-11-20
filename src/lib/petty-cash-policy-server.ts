import type { SupabaseClient } from "@supabase/supabase-js";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { PC_RECEIPT_NUDGE_DEFAULT } from "@/lib/petty-cash-attachments";
import { PC_SECOND_APPROVAL_DEFAULT } from "@/lib/petty-cash-approval";

export interface PettyCashPolicy {
  /** From this amount a missing bill is flagged. */
  nudgeAmount: number;
  /** From this amount an expense needs a second approval (an admin deciding alone is enough). */
  secondApprovalAmount: number;
}

function positive(raw: string | null | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reads both thresholds from app_settings, falling back to the defaults when a row is absent. */
export async function getPettyCashPolicy(admin: SupabaseClient): Promise<PettyCashPolicy> {
  const s = await getCachedSettings(admin, ["petty_cash_receipt_nudge_amount", "petty_cash_second_approval_amount"]);
  return {
    nudgeAmount: positive(s.petty_cash_receipt_nudge_amount, PC_RECEIPT_NUDGE_DEFAULT),
    secondApprovalAmount: positive(s.petty_cash_second_approval_amount, PC_SECOND_APPROVAL_DEFAULT),
  };
}
