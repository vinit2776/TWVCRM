import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import { istDayKey } from "@/lib/lead-days";
import { leadStaleState, latestInstant, NON_EVENT_SUBJECTS } from "@/lib/lead-stale";
import {
  activityEvent,
  contractEvents,
  enquiryEvent,
  nextStep,
  paymentEvent,
  proposalEvents,
  sortTimeline,
  statementEvent,
  type ActivityRow,
  type EnquiryRow,
  type ProposalRow,
  type ContractRow,
  type StatementRow,
  type PaymentRow,
  type TimelineEvent,
} from "@/lib/lead-timeline";

const ACTIVITY_LIMIT = 300;

// GET /api/leads/[id]/timeline
// Everything that happened on a lead as one list, newest first, each event with who did it and links
// to the proposal, contract, invoice or receipt it refers to. Read-only; runs under the caller's own
// permissions, so a person only ever sees what they could already open.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [leadRes, activitiesRes, enquiriesRes, proposalsRes, contractsRes] = await Promise.all([
    supabase.from("leads").select("status, created_at, archived_at, pinned_at").eq("id", id).single(),
    supabase
      .from("activities")
      .select(
        "id, type, subject, description, call_outcome, meeting_start_at, meeting_location, follow_up_date, follow_up_notes, is_follow_up_done, created_at, creator:users!activities_created_by_fkey(full_name)"
      )
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    supabase
      .from("lead_enquiries")
      .select("id, reference, source, received_at, payload")
      .eq("lead_id", id)
      .or("resolution_outcome.is.null,resolution_outcome.neq.spam"),
    supabase
      .from("proposals")
      .select("id, proposal_number, total_amount, created_at, sent_at, viewed_at, accepted_at, creator:users!proposals_created_by_fkey(full_name)")
      .eq("lead_id", id),
    supabase.from("contracts").select("id, contract_number, created_at, activated_at").eq("lead_id", id),
  ]);

  for (const res of [activitiesRes, enquiriesRes, proposalsRes, contractsRes]) {
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const activities = (activitiesRes.data ?? []) as unknown as (ActivityRow & { is_follow_up_done?: boolean })[];
  const contracts = (contractsRes.data ?? []) as ContractRow[];

  // Invoices and the payments against them belong to the lead's contracts.
  let statements: StatementRow[] = [];
  let payments: PaymentRow[] = [];
  if (contracts.length > 0) {
    const { data } = await supabase
      .from("billing_statements")
      .select("id, statement_number, total_amount, created_at")
      .in("contract_id", contracts.map((c) => c.id))
      .neq("status", "voided");
    statements = (data ?? []) as StatementRow[];
  }
  if (statements.length > 0) {
    const { data } = await supabase
      .from("billing_payments")
      .select("id, billing_statement_id, amount, payment_mode, created_at, razorpay_payment_id, recorder:users!billing_payments_recorded_by_fkey(full_name)")
      .in("billing_statement_id", statements.map((s) => s.id));
    payments = (data ?? []) as unknown as PaymentRow[];
  }
  const statementNumber = new Map(statements.map((s) => [s.id, s.statement_number]));

  const events: TimelineEvent[] = [
    ...activities.map(activityEvent),
    ...((enquiriesRes.data ?? []) as EnquiryRow[]).map((e) =>
      enquiryEvent(e, LEAD_SOURCE_LABELS[e.source] ?? e.source)
    ),
    ...((proposalsRes.data ?? []) as unknown as (ProposalRow & { creator?: { full_name?: string | null } | null })[]).flatMap((p) =>
      proposalEvents(p, p.creator?.full_name ?? null)
    ),
    ...contracts.flatMap(contractEvents),
    ...statements.map((s) => statementEvent(s, formatCurrency)),
    ...payments.map((p) => paymentEvent(p, statementNumber.get(p.billing_statement_id) ?? "invoice", formatCurrency)),
  ];

  // A form lead keeps what it asked for on the enquiry, not on the lead itself.
  const latest = ((enquiriesRes.data ?? []) as (EnquiryRow & {
    payload?: { workspace_type?: string; seat_capacity?: number; budget_per_seat?: number; preferred_location?: string } | null;
  })[])
    .slice()
    .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))[0];
  const requirement = latest?.payload
    ? {
        workspace_type: latest.payload.workspace_type ?? null,
        seat_capacity: latest.payload.seat_capacity ?? null,
        budget_per_seat: latest.payload.budget_per_seat ?? null,
        preferred_location: latest.payload.preferred_location ?? null,
      }
    : null;

  // Has the lead gone quiet? Same rule as the Leads list and the daily archive job.
  const lead = leadRes.data;
  const today = istDayKey(new Date());
  const stale = lead
    ? leadStaleState({
        status: lead.status,
        archivedAt: lead.archived_at,
        pinnedAt: lead.pinned_at,
        lastEventAt:
          latestInstant([
            lead.created_at,
            ...activities.filter((a) => !(NON_EVENT_SUBJECTS as readonly string[]).includes(a.subject ?? "")).map((a) => a.created_at),
            ...((enquiriesRes.data ?? []) as EnquiryRow[]).map((e) => e.received_at),
          ]) ?? lead.created_at,
        hasFutureFollowUp: activities.some(
          (a) => !a.is_follow_up_done && !!a.follow_up_date && istDayKey(a.follow_up_date) >= today,
        ),
      })
    : { state: "active" as const };

  return NextResponse.json({
    data: {
      events: sortTimeline(events),
      stale,
      requirement,
      next_step: nextStep(activities),
      truncated: activities.length >= ACTIVITY_LIMIT,
    },
  });
}
