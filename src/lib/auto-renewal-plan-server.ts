import type { SupabaseClient } from "@supabase/supabase-js";
import { effectiveDueDate } from "@/lib/sales-widget";
import { balanceDue, paymentCredit } from "@/lib/settlement";
import type { AutoRenewFacts, PlanLine } from "@/lib/auto-renewal-plan";

/**
 * Loads the facts the auto-renewal planner needs for every contract that has
 * auto-renewal switched on. READ ONLY: it selects and nothing else.
 *
 * Returns null when the auto_renew column does not exist on this database yet
 * (migration 00662 not applied), so the caller can say so instead of failing.
 */
export async function loadAutoRenewFacts(admin: SupabaseClient, today: string): Promise<AutoRenewFacts[] | null> {
  const { data: contracts, error } = await admin
    .from("contracts")
    .select(
      "*, lead:leads!contracts_lead_id_fkey(first_name, last_name, company), location:locations!contracts_location_id_fkey(name)",
    )
    .eq("auto_renew", true)
    .in("status", ["active", "renewal_in_progress"]);

  if (error) {
    // 42703 undefined_column: the migration has not reached this database.
    if (error.code === "42703") return null;
    throw new Error(`auto-renew: could not read contracts: ${error.message}`);
  }
  if (!contracts || contracts.length === 0) return [];

  const ids = contracts.map((c) => c.id as string);
  const firstOfMonth = `${today.slice(0, 7)}-01`;

  const [statements, moratoriums, waivers, phases, exits, drafts] = await Promise.all([
    admin
      .from("billing_statements")
      .select("id, contract_id, total_amount, due_date, gst_invoice_due_date")
      .in("contract_id", ids)
      .in("status", ["finalized", "exported"])
      .in("payment_status", ["unpaid", "partially_paid"])
      .is("voided_at", null),
    admin
      .from("contract_billing_moratoriums")
      .select("contract_id")
      .in("contract_id", ids)
      .eq("status", "approved")
      .gte("moratorium_month", firstOfMonth),
    admin
      .from("contract_rent_waivers")
      .select("contract_id")
      .in("contract_id", ids)
      .is("revoked_at", null)
      .gte("waived_month", firstOfMonth),
    admin.from("contract_rate_phases").select("contract_id").in("contract_id", ids),
    admin.from("contract_exits").select("contract_id").in("contract_id", ids).eq("status", "in_notice"),
    admin
      .from("contracts")
      .select("parent_contract_id, subtotal, escalation_percentage")
      .in("parent_contract_id", ids)
      .eq("is_renewal", true)
      .not("status", "in", '("terminated","rejected")'),
  ]);

  for (const [name, res] of Object.entries({ statements, moratoriums, waivers, phases, exits, drafts })) {
    if (res.error) throw new Error(`auto-renew: could not read ${name}: ${res.error.message}`);
  }

  // Overdue = finalized/exported, unpaid or part-paid, not voided, past its due date: the same
  // rule Accounts' receivables use. The amount is what is still owed after payments and TDS.
  const overdueStatements = (statements.data ?? []).filter((s) => {
    const due = effectiveDueDate({ gst_invoice_due_date: s.gst_invoice_due_date, due_date: s.due_date });
    return due != null && due.slice(0, 10) < today;
  });
  const paidByStatement = new Map<string, number>();
  if (overdueStatements.length > 0) {
    const { data: pays, error: payErr } = await admin
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", overdueStatements.map((s) => s.id as string));
    if (payErr) throw new Error(`auto-renew: could not read payments: ${payErr.message}`);
    for (const p of pays ?? []) {
      const sid = p.billing_statement_id as string;
      paidByStatement.set(sid, (paidByStatement.get(sid) ?? 0) + paymentCredit({ amount: p.amount, tds_amount: p.tds_amount }));
    }
  }
  const overdueByContract = new Map<string, number>();
  for (const s of overdueStatements) {
    const owed = balanceDue(s.total_amount, paidByStatement.get(s.id as string) ?? 0);
    if (owed > 0) overdueByContract.set(s.contract_id as string, (overdueByContract.get(s.contract_id as string) ?? 0) + owed);
  }

  const idSet = (rows: { contract_id?: string; parent_contract_id?: string }[] | null, key: "contract_id" | "parent_contract_id") =>
    new Set((rows ?? []).map((r) => r[key] as string));
  const withMoratorium = idSet(moratoriums.data, "contract_id");
  const withWaiver = idSet(waivers.data, "contract_id");
  const withPhases = idSet(phases.data, "contract_id");
  const exiting = idSet(exits.data, "contract_id");
  const draftByParent = new Map(
    (drafts.data ?? []).map((d) => [
      d.parent_contract_id as string,
      {
        subtotal: Number(d.subtotal ?? 0),
        escalationPercentage: d.escalation_percentage == null ? null : Number(d.escalation_percentage),
      },
    ]),
  );

  return contracts.map((c) => {
    const lead = c.lead as { first_name: string | null; last_name: string | null; company: string | null } | null;
    const customer =
      lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Customer";
    return {
      id: c.id as string,
      contractNumber: c.contract_number as string,
      customer,
      location: (c.location as { name: string } | null)?.name ?? null,
      status: c.status as string,
      endDate: String(c.end_date).slice(0, 10),
      noticePeriodMonths: c.notice_period_months == null ? null : Number(c.notice_period_months),
      seats: Number(c.seats ?? 1),
      items: ((c.items ?? []) as PlanLine[]).map((i) => ({
        description: i.description,
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        escalates: i.escalates,
      })),
      subtotal: Number(c.subtotal ?? 0),
      agreementEscalationPercentage:
        c.agreement_escalation_percentage == null ? null : Number(c.agreement_escalation_percentage),
      escalationPercentage: c.escalation_percentage == null ? null : Number(c.escalation_percentage),
      renewalDeclined: !!c.renewal_declined,
      hasLiveExit: exiting.has(c.id as string),
      overdueAmount: overdueByContract.get(c.id as string) ?? 0,
      hasActiveMoratorium: withMoratorium.has(c.id as string),
      hasActiveRentWaiver: withWaiver.has(c.id as string),
      hasRatePhases: withPhases.has(c.id as string),
      specialClauseStatus: (c.special_clause_status as string | null) ?? null,
      escalationApprovalPending: c.escalation_approval_status === "pending",
      renewalDraft: draftByParent.get(c.id as string) ?? null,
    };
  });
}
