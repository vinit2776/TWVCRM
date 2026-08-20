/**
 * Loads the non-statement receivables (deposits, top-ups, ad-hoc PIs) in the
 * shape the reminder ladder needs.
 *
 * Shared by the daily cron and the manual "Send Reminder Now" button so the
 * two can never disagree about who is chaseable — in particular the
 * accepted-proposal gate on deposits, which is the difference between
 * chasing a customer and pestering a prospect.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { depositIsChaseable } from "@/lib/receivables";

export type DunnableKind = "deposit" | "topup" | "adhoc_invoice";

export interface DunnableRow {
  kind: DunnableKind;
  id: string;
  reference: string;
  party_name: string;
  email: string | null;
  phone: string | null;
  amount: number;
  due_date: string | null;
  payment_link_url: string | null;
  followup_enabled: boolean;
  reminder_count: number;
  last_reminder_sent_at: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const party = (lead: any) =>
  lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Customer";

export async function fetchDunnableReceivables(
  admin: SupabaseClient,
  only?: { kind: DunnableKind; id: string },
): Promise<DunnableRow[]> {
  const out: DunnableRow[] = [];
  const want = (k: DunnableKind) => !only || only.kind === k;

  if (want("deposit")) {
    let q = admin
      .from("proposals")
      .select(`
        id, proposal_number, status, security_deposit_amount, deposit_credit_amount,
        deposit_exception_amount,
        deposit_due_date, deposit_razorpay_link_url, deposit_razorpay_link_id,
        deposit_link_cancelled_at,
        deposit_reminder_count, deposit_last_reminder_sent_at,
        lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile)
      `)
      .eq("deposit_payment_status", "pending")
      .gt("security_deposit_amount", 0);
    if (only) q = q.eq("id", only.id);
    const { data } = await q;

    for (const d of data || []) {
      // Accepted, or asked for concretely with a payment link that is still live.
      if (!depositIsChaseable({
        status: d.status as string,
        deposit_razorpay_link_id: d.deposit_razorpay_link_id as string | null,
        deposit_link_cancelled_at: d.deposit_link_cancelled_at as string | null,
      })) continue;
      const owed = Number(d.security_deposit_amount || 0) + Number(d.deposit_exception_amount || 0) - Number(d.deposit_credit_amount || 0);
      if (owed <= 0) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = d.lead as any;
      out.push({
        kind: "deposit", id: d.id, reference: d.proposal_number, party_name: party(lead),
        email: lead?.email ?? null, phone: lead?.mobile || lead?.phone || null,
        amount: owed, due_date: d.deposit_due_date,
        payment_link_url: d.deposit_razorpay_link_url,
        followup_enabled: true,
        reminder_count: d.deposit_reminder_count || 0,
        last_reminder_sent_at: d.deposit_last_reminder_sent_at,
      });
    }
  }

  if (want("topup")) {
    let q = admin
      .from("deposit_topups")
      .select(`
        id, amount, due_date, razorpay_payment_link_url, reminder_count, last_reminder_sent_at,
        contract:contracts!deposit_topups_contract_id_fkey(
          contract_number,
          lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile)
        )
      `)
      .eq("status", "pending");
    if (only) q = q.eq("id", only.id);
    const { data } = await q;

    for (const t of data || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = t.contract as any;
      out.push({
        kind: "topup", id: t.id, reference: contract?.contract_number || "—",
        party_name: party(contract?.lead), email: contract?.lead?.email ?? null,
        phone: contract?.lead?.mobile || contract?.lead?.phone || null,
        amount: Number(t.amount || 0), due_date: t.due_date,
        payment_link_url: t.razorpay_payment_link_url,
        followup_enabled: true,
        reminder_count: t.reminder_count || 0,
        last_reminder_sent_at: t.last_reminder_sent_at,
      });
    }
  }

  if (want("adhoc_invoice")) {
    let q = admin
      .from("proforma_invoices")
      .select(`
        id, invoice_number, total_amount, due_date, razorpay_link_url,
        followup_enabled, reminder_count, last_reminder_sent_at,
        lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company, email, phone, mobile)
      `)
      .not("status", "in", "(paid,cancelled)");
    if (only) q = q.eq("id", only.id);
    const { data } = await q;

    for (const inv of data || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = inv.lead as any;
      out.push({
        kind: "adhoc_invoice", id: inv.id, reference: inv.invoice_number, party_name: party(lead),
        email: lead?.email ?? null, phone: lead?.mobile || lead?.phone || null,
        amount: Number(inv.total_amount || 0), due_date: inv.due_date,
        payment_link_url: inv.razorpay_link_url,
        followup_enabled: inv.followup_enabled !== false,
        reminder_count: inv.reminder_count || 0,
        last_reminder_sent_at: inv.last_reminder_sent_at,
      });
    }
  }

  return out;
}
