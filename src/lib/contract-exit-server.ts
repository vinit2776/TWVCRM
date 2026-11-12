import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { balanceDue, paymentCredit } from "@/lib/settlement";
import { fetchUnbilledCharges } from "@/lib/usage-billing";
import { computeSettlement, exitDepositAvailable, ownDepositRemaining, reservedForContract, type DepositContractRow, type Settlement } from "@/lib/contract-exit";

/**
 * Server-side loaders for the exit workflow. Reads use the admin client; every
 * caller has already checked the user's role.
 */

export interface ExitRow {
  id: string;
  contract_id: string;
  status: "in_notice" | "completed" | "cancelled";
  notice_received_on: string;
  last_day: string;
  reason: string;
  is_early_exit: boolean;
  started_by: string | null;
  started_at: string;
  inspection_done_at: string | null;
  inspection_done_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  started_by_name?: string | null;
  completed_by_name?: string | null;
  inspection_done_by_name?: string | null;
}

export interface ExitChargeRow {
  id: string;
  exit_id: string;
  charge_type: string;
  description: string;
  amount: number;
  added_by: string | null;
  added_by_name?: string | null;
  added_at: string;
  updated_at: string | null;
  edited_after_add: boolean;
}

export interface UnpaidInvoice {
  id: string;
  reference: string | null;
  balance_due: number;
  due_date: string | null;
}

export interface ExitView {
  exit: ExitRow;
  charges: ExitChargeRow[];
  unpaidInvoices: UnpaidInvoice[];
  /** What this exit may settle (pool, less other contracts' needs, capped at this contract's own deposit). */
  depositAvailable: number;
  /** The customer's whole pooled balance. */
  depositPool: number;
  /** Held back for the customer's other live contracts. */
  reservedForOthers: number;
  depositCollected: number;
  /** Ex-GST total of billable (not held) unbilled usage. */
  unbilledUsage: number;
  settlement: Settlement;
}

/** The live (in_notice or completed) exit for a contract, if any. */
export async function getLiveExit(admin: SupabaseClient, contractId: string): Promise<ExitRow | null> {
  const { data } = await admin
    .from("contract_exits")
    .select("*, started_user:users!contract_exits_started_by_fkey(full_name), completed_user:users!contract_exits_completed_by_fkey(full_name), inspection_user:users!contract_exits_inspection_done_by_fkey(full_name)")
    .eq("contract_id", contractId)
    .in("status", ["in_notice", "completed"])
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown> & {
    started_user?: { full_name: string | null } | null;
    completed_user?: { full_name: string | null } | null;
    inspection_user?: { full_name: string | null } | null;
  };
  const { started_user, completed_user, inspection_user, ...rest } = r;
  return {
    ...(rest as unknown as ExitRow),
    started_by_name: started_user?.full_name ?? null,
    completed_by_name: completed_user?.full_name ?? null,
    inspection_done_by_name: inspection_user?.full_name ?? null,
  };
}

export async function loadExitView(admin: SupabaseClient, contractId: string): Promise<ExitView | null> {
  const exit = await getLiveExit(admin, contractId);
  if (!exit) return null;

  const DEPOSIT_COLS = "security_deposit_amount, deposit_payment_status, deposit_payment_amount, deposit_refunded_amount, deposit_pool_applied_amount";
  const { data: thisContract } = await admin.from("contracts").select(`lead_id, ${DEPOSIT_COLS}`).eq("id", contractId).single();
  const { data: otherLive } = thisContract
    ? await admin.from("contracts").select(DEPOSIT_COLS).eq("lead_id", (thisContract as { lead_id: string }).lead_id)
        .in("status", ["active", "renewal_in_progress"]).neq("id", contractId)
    : { data: [] };

  const [chargesRes, balanceRes, statementsRes, unbilled] = await Promise.all([
    admin
      .from("contract_exit_charges")
      .select("*, added_user:users!contract_exit_charges_added_by_fkey(full_name)")
      .eq("exit_id", exit.id)
      .order("added_at", { ascending: true }),
    admin.rpc("get_deposit_available_balance", { p_contract_id: contractId }),
    admin
      .from("billing_statements")
      .select("id, statement_number, gst_invoice_number, total_amount, due_date")
      .eq("contract_id", contractId)
      .in("status", ["finalized", "exported"])
      .in("payment_status", ["unpaid", "partially_paid"])
      .is("voided_at", null)
      .order("due_date", { ascending: true, nullsFirst: false }),
    fetchUnbilledCharges(admin, contractId).catch((err) => {
      console.error("[contract-exit] unbilled usage failed", err);
      return [];
    }),
  ]);

  const charges = ((chargesRes.data ?? []) as Array<Record<string, unknown> & { added_user?: { full_name: string | null } | null }>).map((c) => {
    const { added_user, ...rest } = c;
    return { ...(rest as unknown as ExitChargeRow), amount: Number(c.amount), added_by_name: added_user?.full_name ?? null };
  });

  const statements = statementsRes.data ?? [];
  const ids = statements.map((s) => s.id as string);
  const paid = new Map<string, number>();
  if (ids.length > 0) {
    const { data: payments } = await admin
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", ids);
    for (const p of payments ?? []) {
      const row = p as { billing_statement_id: string; amount: number; tds_amount: number | null };
      paid.set(row.billing_statement_id, (paid.get(row.billing_statement_id) ?? 0) + paymentCredit(row));
    }
  }
  const unpaidInvoices: UnpaidInvoice[] = statements.map((s) => ({
    id: s.id as string,
    reference: (s.gst_invoice_number as string | null) ?? (s.statement_number as string | null) ?? null,
    balance_due: balanceDue(s.total_amount as number, paid.get(s.id as string) ?? 0),
    due_date: (s.due_date as string | null) ?? null,
  })).filter((i) => i.balance_due > 0);

  const bal = (balanceRes.data as Array<{ available: number; deposit_collected: number }> | null)?.[0];
  const depositPool = Number(bal?.available ?? 0);
  const reservedForOthers = ((otherLive ?? []) as unknown as DepositContractRow[]).reduce((n, c) => n + reservedForContract(c), 0);
  const ownRemaining = thisContract ? ownDepositRemaining(thisContract as unknown as DepositContractRow) : 0;
  const depositAvailable = exitDepositAvailable(depositPool, ownRemaining, reservedForOthers);
  const unbilledUsage = Math.round(unbilled.filter((u) => !u.held).reduce((n, u) => n + u.amount, 0) * 100) / 100;

  const settlement = computeSettlement({
    depositAvailable,
    charges: charges.reduce((n, c) => n + c.amount, 0),
    unpaidInvoices: unpaidInvoices.reduce((n, i) => n + i.balance_due, 0),
    unbilledUsage,
  });

  return {
    exit, charges, unpaidInvoices, depositAvailable, depositPool, reservedForOthers,
    depositCollected: Number(bal?.deposit_collected ?? 0),
    unbilledUsage, settlement,
  };
}

/** Tell every active CRM user (in-app and push). Internal only; never reaches a customer. */
export async function notifyAllUsers(
  admin: SupabaseClient,
  n: { title: string; body: string; url: string; contractId: string }
): Promise<void> {
  const { data } = await admin.from("users").select("id").eq("is_active", true);
  const ids = (data ?? []).map((u) => u.id as string);
  if (ids.length === 0) return;
  await createNotificationsForUsers(ids, {
    type: "contract_exit",
    title: n.title,
    body: n.body,
    url: n.url,
    entityType: "contract",
    entityId: n.contractId,
  });
  await sendPushToUsers(ids, { title: n.title, body: n.body, url: n.url, tag: `exit-${n.contractId}` }).catch((err) =>
    console.error("[contract-exit] push failed:", err)
  );
}

/**
 * Called after a live contract has been terminated. If it has an open exit,
 * mark that exit completed and tell the team. A no-op for contracts that were
 * terminated without an exit (e.g. directly by an admin).
 */
export async function completeExitOnTerminate(
  admin: SupabaseClient,
  p: { contractId: string; contractNumber: string | null; actorId: string | null; customer: string }
): Promise<void> {
  const { data: updated } = await admin
    .from("contract_exits")
    .update({ status: "completed", completed_at: new Date().toISOString(), completed_by: p.actorId, updated_at: new Date().toISOString() })
    .eq("contract_id", p.contractId)
    .eq("status", "in_notice")
    .select("id");
  if (!updated || updated.length === 0) return;
  await notifyAllUsers(admin, {
    title: `Exit completed: ${p.customer}${p.contractNumber ? ` (${p.contractNumber})` : ""}`,
    body: "Access removed and seats released.",
    url: `/contracts/${p.contractId}/exit`,
    contractId: p.contractId,
  });
}
