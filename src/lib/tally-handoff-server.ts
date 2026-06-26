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
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { formatCurrency } from "@/lib/utils";

/** Where per-event intimations land. EMAIL_REPLY_TO is the canonical accounts inbox. */
const ACCOUNTS_INBOX_EMAIL = EMAIL_REPLY_TO;
const INBOX_URL_PATH = "/accounting/inbox";

/** States where accounts has a new task and should be pinged immediately. */
const INTIMATION_STATES: Partial<Record<HandoffState, { subjectVerb: string; body: string }>> = {
  pi_paid_awaiting_gst: {
    subjectVerb: "Payment received — please issue GST invoice in Tally",
    body:
      "Customer has paid the proforma invoice. Please create the GST tax invoice " +
      "in Tally, generate the IRN, and upload the PDF to the inbox.",
  },
  direct_gst_requested: {
    subjectVerb: "New direct GST invoice request",
    body:
      "A statement on a direct-GST contract has been finalized. Please create " +
      "the GST tax invoice in Tally and upload the PDF to the inbox.",
  },
  paid_awaiting_receipt_record: {
    subjectVerb: "Payment received — please record receipt in Tally",
    body:
      "Customer has paid a GST invoice. Please record the receipt voucher in Tally; " +
      "the bridge will verify it automatically on the next sync.",
  },
};

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

  // Lightweight server log alongside the audit entry below.
  console.info(
    `[tally-handoff] statement=${statementId} state ${previousState ?? "(null)"} → ${newState} trigger=${trigger}`,
  );

  // Audit log — drives the StatementTimeline component (PR A of lifecycle
  // visibility). performed_by is null for system-triggered transitions
  // (webhook, cron, bridge sync); the trigger string identifies which
  // pathway fired the change.
  await supabase.from("audit_trail").insert({
    entity_type: "billing_statement",
    entity_id: statementId,
    action: "update",
    performed_by: null,
    changes: {
      handoff_state: { old: previousState, new: newState },
      trigger,
    },
  }).then(({ error: auditErr }) => {
    if (auditErr) {
      console.error(
        `[tally-handoff] audit_trail insert failed for statement=${statementId}:`,
        auditErr.message,
      );
    }
  });

  // Fire-and-forget per-event intimation. Errors are logged but never bubble
  // up — a flaky SMTP server should not break payment capture or invoice
  // upload paths.
  if (INTIMATION_STATES[newState]) {
    void notifyAccountsOfHandoffTransition(supabase, statementId, newState).catch((err) => {
      console.error(
        `[tally-handoff] intimation email failed for statement=${statementId} state=${newState}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}

/**
 * Sends a one-line intimation email to the accounts inbox when a statement
 * transitions to a state that needs human attention. Skipped silently if
 * the target state has no intimation configured.
 *
 * Errors are surfaced to the caller (which fires-and-forgets); they never
 * block the main state-change flow.
 */
async function notifyAccountsOfHandoffTransition(
  supabase: SupabaseClient,
  statementId: string,
  newState: HandoffState,
): Promise<void> {
  const intimation = INTIMATION_STATES[newState];
  if (!intimation) return;

  const { data: statementRow } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, total_amount,
      contract:contracts!billing_statements_contract_id_fkey(
        contract_number,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
      )
    `)
    .eq("id", statementId)
    .maybeSingle();

  if (!statementRow) return;

  const statement = statementRow as unknown as {
    statement_number: string | null;
    total_amount: number;
    contract: {
      contract_number: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null } | null;
    } | null;
  };

  const partyName =
    statement.contract?.lead?.company
    || [statement.contract?.lead?.first_name, statement.contract?.lead?.last_name].filter(Boolean).join(" ")
    || "(unnamed customer)";

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();

  const subject = `[Tally inbox] ${intimation.subjectVerb} — ${partyName}`;
  const html = `
    <p>${intimation.body}</p>
    <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Customer</td><td><strong>${escapeHtml(partyName)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Contract</td><td>${escapeHtml(statement.contract?.contract_number ?? "—")}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Statement</td><td>${escapeHtml(statement.statement_number ?? "—")}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Amount</td><td><strong>${formatCurrency(Number(statement.total_amount))}</strong></td></tr>
    </table>
    <p><a href="${appUrl}${INBOX_URL_PATH}" style="display:inline-block;padding:8px 16px;background:#111;color:#fff;text-decoration:none;border-radius:4px;">Open Tally inbox</a></p>
  `;

  await resend.emails.send({
    from: EMAIL_FROM,
    to: ACCOUNTS_INBOX_EMAIL,
    subject,
    html,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
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

  const currentState = (statement as unknown as { handoff_state: string | null }).handoff_state;

  // If GST invoice was already sent and we're now recording payment (e.g. bank
  // transfer on an Override/PI-cancelled statement), close the loop directly.
  if (currentState === "gst_sent_awaiting_payment") {
    await setHandoffState(supabase, statementId, "complete", trigger);
    return;
  }

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

/**
 * Called when a statement is auto-finalized by the monthly billing cron.
 *
 * For `gst_direct` contracts under v2, this is the entry point into the
 * accounts inbox: the statement is ready, no PI was sent, the customer
 * is waiting for a GST invoice that accounts has to create in Tally.
 *
 * Returns a flag the caller can use to decide whether to skip the legacy
 * CRM-side dispatch (dispatchGstDirect):
 *   - v2 ON + gst_direct: handoff_state = 'direct_gst_requested',
 *     skipLegacyDispatch = true (accounts owns the invoice now)
 *   - v2 ON + proforma_first: PR #2c handles state at payment time;
 *     the legacy proforma dispatch (PI) still runs.
 *     skipLegacyDispatch = false
 *   - v2 OFF: no-op. skipLegacyDispatch = false (legacy behaviour).
 */
export async function handleStatementFinalized(
  supabase: SupabaseClient,
  statementId: string,
  billingMode: "proforma_first" | "gst_direct" | null | undefined,
  trigger: string,
): Promise<{ skipLegacyDispatch: boolean }> {
  const v2Enabled = await isHandoffV2Enabled(supabase);
  if (!v2Enabled) {
    return { skipLegacyDispatch: false };
  }

  if (billingMode === "gst_direct") {
    await setHandoffState(supabase, statementId, "direct_gst_requested", trigger);
    return { skipLegacyDispatch: true };
  }

  // proforma_first or unknown: the PI dispatch (legacy) still runs; handoff
  // state will be written at payment-capture time by handleStatementPaid.
  return { skipLegacyDispatch: false };
}
