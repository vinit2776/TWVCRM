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
import { loadPartReceivableState } from "@/lib/deposit-instalment-server";
import { invoiceParty } from "@/lib/invoice-party";
import { balanceDue, totalPaid } from "@/lib/settlement";
import { bookingPiChaseable, BOOKING_PI_CREATED_VIA } from "@/lib/booking-pi-statement";

export type DunnableKind = "deposit" | "topup" | "adhoc_invoice" | "booking_pi";

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
  /** Razorpay link id, so the reminder can check the link is still live. */
  payment_link_id: string | null;
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
    // A deposit collected in parts is not on the automatic ladder: every reminder
    // names the whole deposit and the proposal's single link. Parts are followed
    // up from the proposal (and show on the Receivables screen).
    const inParts = await loadPartReceivableState(admin, (data || []).map((d) => d.id as string));

    for (const d of data || []) {
      if (inParts.has(d.id as string)) continue;
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
        payment_link_id: d.deposit_razorpay_link_id,
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
        id, amount, due_date, razorpay_payment_link_url, razorpay_payment_link_id, reminder_count, last_reminder_sent_at,
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
        payment_link_id: t.razorpay_payment_link_id,
        followup_enabled: true,
        reminder_count: t.reminder_count || 0,
        last_reminder_sent_at: t.last_reminder_sent_at,
      });
    }
  }

  if (want("adhoc_invoice")) {
    // Can be raised against a lead OR a Virtual Office case (migration
    // 00532) — a case has no lead, so without this join a case-billed
    // invoice resolved to party_name "Customer" with no email/phone, and
    // the reminder route below rejects with 422 for having neither. Same
    // fix as fetchOtherReceivables() in the AR route, applied here so the
    // "Remind" button and the daily cron stop silently skipping these.
    let q = admin
      .from("proforma_invoices")
      .select(`
        id, invoice_number, total_amount, due_date, razorpay_link_url, razorpay_link_id,
        followup_enabled, reminder_count, last_reminder_sent_at,
        lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company, email, phone, mobile),
        case:cases!proforma_invoices_case_id_fkey(
          id, case_number, client_name, client_company_name, client_email, client_phone,
          client_gst_number, aggregator_id, bill_to,
          aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number)
        )
      `)
      .not("status", "in", "(paid,cancelled)");
    if (only) q = q.eq("id", only.id);
    const { data } = await q;

    for (const inv of data || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = inv.lead as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caseRow = inv.case as any;
      const invParty = !lead && caseRow ? invoiceParty({ case: caseRow }) : null;
      out.push({
        kind: "adhoc_invoice", id: inv.id, reference: inv.invoice_number,
        party_name: lead ? party(lead) : (invParty?.name || "Customer"),
        email: lead?.email ?? invParty?.email ?? null,
        phone: lead?.mobile || lead?.phone || invParty?.phone || null,
        amount: Number(inv.total_amount || 0), due_date: inv.due_date,
        payment_link_url: inv.razorpay_link_url,
        payment_link_id: inv.razorpay_link_id,
        followup_enabled: inv.followup_enabled !== false,
        reminder_count: inv.reminder_count || 0,
        last_reminder_sent_at: inv.last_reminder_sent_at,
      });
    }
  }

  if (want("booking_pi")) {
    // A booking's PI is a billing statement owned by the booking. It is chased
    // here, not in the statement pass, because the statement pass resolves the
    // customer through a contract, proposal or invoice and a booking has none.
    let q = admin
      .from("billing_statements")
      .select(`
        id, statement_number, total_amount, due_date, razorpay_payment_link_id, razorpay_payment_link_url,
        reminder_count, last_reminder_sent_at, emailed_at, proforma_sent_at,
        booking:bookings!billing_statements_booking_id_fkey(
          booking_number, status, payment_status, guest_name, guest_email, guest_phone, guest_company,
          lead:leads!bookings_lead_id_fkey(first_name, last_name, company, email, phone, mobile)
        )
      `)
      .eq("created_via", BOOKING_PI_CREATED_VIA)
      .in("status", ["finalized", "exported"])
      .in("payment_status", ["unpaid", "partially_paid"])
      .is("voided_at", null);
    if (only) q = q.eq("id", only.id);
    const { data } = await q;

    const ids = (data || []).map((s) => s.id as string);
    const paidBy = new Map<string, { amount: number; tds_amount: number | null }[]>();
    if (ids.length > 0) {
      const { data: pays } = await admin
        .from("billing_payments")
        .select("billing_statement_id, amount, tds_amount")
        .in("billing_statement_id", ids);
      for (const p of pays || []) {
        const k = p.billing_statement_id as string;
        if (!paidBy.has(k)) paidBy.set(k, []);
        paidBy.get(k)!.push({ amount: Number(p.amount), tds_amount: p.tds_amount as number | null });
      }
    }

    for (const s of data || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const booking = s.booking as any;
      const balance = balanceDue(s.total_amount as number, totalPaid(paidBy.get(s.id as string)));
      if (!bookingPiChaseable({
        booking, emailedAt: s.emailed_at as string | null, proformaSentAt: s.proforma_sent_at as string | null, balance,
      })) continue;
      const lead = booking.lead;
      out.push({
        kind: "booking_pi", id: s.id as string, reference: booking.booking_number || (s.statement_number as string),
        party_name: lead ? party(lead) : (booking.guest_company || booking.guest_name || "Customer"),
        email: lead?.email ?? booking.guest_email ?? null,
        phone: lead?.mobile || lead?.phone || booking.guest_phone || null,
        amount: balance, due_date: s.due_date as string | null,
        payment_link_url: s.razorpay_payment_link_url as string | null,
        payment_link_id: s.razorpay_payment_link_id as string | null,
        followup_enabled: true,
        reminder_count: (s.reminder_count as number) || 0,
        last_reminder_sent_at: s.last_reminder_sent_at as string | null,
      });
    }
  }

  return out;
}
