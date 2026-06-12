/**
 * Tally handoff v2 — SERVER-ONLY helpers.
 *
 * Separated from `tally-handoff.ts` (which holds pure types + label maps
 * safe to import in client components) so server-only imports
 * (`@/lib/supabase/server`, audit logging) don't leak into the client bundle.
 *
 * See docs/tally-handoff-redesign.md §4 for the flow diagrams and §5 for
 * the state transitions this module implements.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoffState } from "@/lib/tally-handoff";

/**
 * Reads the `tally_handoff_v2_enabled` feature flag from app_settings.
 * Returns `false` if the row is missing (pre-migration) or value isn't 'true'.
 *
 * Caller is responsible for short-circuiting the legacy bridge-writer
 * code path when this returns true.
 */
export async function isHandoffV2Enabled(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "tally_handoff_v2_enabled")
    .maybeSingle();
  return data?.value === "true";
}

/**
 * Writes a new handoff_state to a billing statement and logs an audit entry.
 * Idempotent: a no-op if the state is already at newState.
 *
 * The function does NOT validate state transitions — callers are trusted
 * to pass the correct target state for the trigger. The schema CHECK
 * constraint enforces the value is a known state.
 */
export async function setHandoffState(
  supabase: SupabaseClient,
  statementId: string,
  newState: HandoffState,
  trigger: string,
): Promise<void> {
  const { data: current } = await supabase
    .from("billing_statements")
    .select("handoff_state")
    .eq("id", statementId)
    .maybeSingle();

  if (current?.handoff_state === newState) {
    return; // idempotent
  }

  const previousState = (current?.handoff_state as HandoffState | null) ?? null;

  const { error } = await supabase
    .from("billing_statements")
    .update({ handoff_state: newState, updated_at: new Date().toISOString() })
    .eq("id", statementId);

  if (error) {
    console.error(
      `[tally-handoff] setHandoffState failed for statement=${statementId} → ${newState}:`,
      error.message,
    );
    return;
  }

  // Lightweight server log. Deeper audit (audit_trail row with performer)
  // lives in PR #2d when accounts actions drive the transitions; system-
  // triggered transitions are tracked via billing_statements.updated_at.
  console.info(
    `[tally-handoff] statement=${statementId} state ${previousState ?? "(null)"} → ${newState} trigger=${trigger}`,
  );
}

/**
 * Called when a billing statement transitions to payment_status='paid'.
 * Decides the next handoff_state based on the contract's billing_mode.
 *
 * - proforma_first contracts: PI was sent first, payment is for the PI →
 *   set handoff_state='pi_paid_awaiting_gst' so accounts knows to issue
 *   the GST invoice in Tally and upload it.
 *
 * - gst_direct contracts: the GST invoice was already issued (handoff_state
 *   would have been 'gst_sent_awaiting_payment'), so payment means accounts
 *   needs to record the receipt in Tally →
 *   set handoff_state='paid_awaiting_receipt_record'.
 *
 * No-op if billing_mode is unknown or the statement can't be looked up.
 */
export async function handleStatementPaid(
  supabase: SupabaseClient,
  statementId: string,
  trigger: string,
): Promise<void> {
  const { data: statement } = await supabase
    .from("billing_statements")
    .select(`
      id,
      handoff_state,
      contract:contracts!billing_statements_contract_id_fkey(billing_mode)
    `)
    .eq("id", statementId)
    .maybeSingle();

  if (!statement) {
    console.warn(`[tally-handoff] handleStatementPaid: statement ${statementId} not found`);
    return;
  }

  // Supabase types nested FKs as arrays even when the FK is single-row.
  const billingMode = ((statement as unknown as {
    contract: { billing_mode: "proforma_first" | "gst_direct" | null } | null;
  }).contract)?.billing_mode;

  if (billingMode === "proforma_first") {
    await setHandoffState(supabase, statementId, "pi_paid_awaiting_gst", trigger);
    return;
  }

  if (billingMode === "gst_direct") {
    await setHandoffState(supabase, statementId, "paid_awaiting_receipt_record", trigger);
    return;
  }

  // Unknown billing_mode (e.g. legacy contract) — leave handoff_state alone.
  // The legacy bridge-writer flow handles these; v2 only manages contracts
  // that have an explicit billing_mode.
  console.warn(
    `[tally-handoff] handleStatementPaid: statement ${statementId} has unknown billing_mode (${billingMode}); skipping`,
  );
}
