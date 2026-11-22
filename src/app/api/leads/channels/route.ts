import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import { istDayKey } from "@/lib/lead-days";
import { NON_EVENT_SUBJECTS } from "@/lib/lead-stale";
import { channelFunnel, reachedBy, sourceLabel, trustLines, TOO_FEW_TO_JUDGE, type ChannelLead, type Promotion, type TrustFacts } from "@/lib/channels-report";

const MAX_LEADS = 5000;
const CHUNK = 150;
const AD_SOURCES = ["meta_ads", "google_ads"];

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// GET /api/leads/channels?days=30|90|365
// Which source sends enquiries that become customers: per source, the enquiries that came in during
// the period and how far they got (junk, reached, tour, proposal, won = an activated contract), the
// first-contact time, the spend from the promotions tied to that source and the cost per win, with
// a verdict each ("too few to judge" under 10 enquiries) and a trust panel of the caveats to read
// first. Read-only; admin and manager only.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !["admin", "manager"].includes(me.role)) return NextResponse.json({ error: "The Channels report is for admin and manager" }, { status: 403 });

  const days = Number(new URL(request.url).searchParams.get("days") ?? "30");
  if (![30, 90, 365].includes(days)) return NextResponse.json({ error: "days must be 30, 90 or 365" }, { status: 400 });
  const today = istDayKey(new Date());
  const from = istDayKey(new Date(Date.now() - (days - 1) * 86400000));
  const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();

  const { data: leadRows, error } = await supabase
    .from("leads")
    .select("id, source, status, created_at")
    .gte("created_at", fromIso)
    .order("created_at", { ascending: false })
    .limit(MAX_LEADS);
  if (error) {
    console.error("[channels] leads load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load the report" }, { status: 500 });
  }
  const leads = (leadRows ?? []) as { id: string; source: string; status: string; created_at: string }[];
  const ids = leads.map((l) => l.id);

  const reached = new Set<string>();
  const tours = new Set<string>();
  const proposals = new Set<string>();
  const won = new Set<string>();
  const firstTouch = new Map<string, string>();
  const touch = (leadId: string, at: string) => {
    const cur = firstTouch.get(leadId);
    if (!cur || Date.parse(at) < Date.parse(cur)) firstTouch.set(leadId, at);
  };

  for (const part of chunks(ids)) {
    const [acts, enqUpdates, props, contracts] = await Promise.all([
      supabase.from("activities").select("lead_id, type, call_outcome, subject, created_at").in("lead_id", part).limit(20000),
      supabase.from("enquiry_updates").select("kind, created_at, enquiry:lead_enquiries!inner(lead_id)").in("enquiry.lead_id", part).limit(20000),
      supabase.from("proposals").select("lead_id, status").in("lead_id", part).neq("status", "superseded").limit(20000),
      supabase.from("contracts").select("lead_id, activated_at").in("lead_id", part).not("activated_at", "is", null).limit(20000),
    ]);
    for (const a of (acts.data ?? []) as { lead_id: string; type: string; call_outcome: string | null; subject: string | null; created_at: string }[]) {
      if ((NON_EVENT_SUBJECTS as readonly string[]).includes(a.subject ?? "")) continue;
      touch(a.lead_id, a.created_at);
      if (reachedBy({ type: a.type, callOutcome: a.call_outcome, subject: a.subject })) reached.add(a.lead_id);
      if (a.type === "tour") tours.add(a.lead_id);
    }
    for (const u of (enqUpdates.data ?? []) as unknown as { kind: string; created_at: string; enquiry: { lead_id: string } | null }[]) {
      if (!u.enquiry?.lead_id) continue;
      touch(u.enquiry.lead_id, u.created_at);
      if (u.kind !== "call_no_answer") reached.add(u.enquiry.lead_id);
    }
    for (const p of (props.data ?? []) as { lead_id: string }[]) proposals.add(p.lead_id);
    for (const c of (contracts.data ?? []) as { lead_id: string }[]) won.add(c.lead_id);
  }

  const channelLeads: ChannelLead[] = leads.map((l) => ({
    source: l.source,
    createdAt: l.created_at,
    status: l.status,
    firstTouchAt: firstTouch.get(l.id) ?? null,
    reached: reached.has(l.id),
    hasTour: tours.has(l.id),
    hasProposal: proposals.has(l.id),
    won: won.has(l.id),
  }));

  const { data: promoRows } = await supabase.from("lead_promotions").select("source, starts_on, ends_on, spend").lte("starts_on", today);
  const promotions: Promotion[] = ((promoRows ?? []) as { source: string | null; starts_on: string; ends_on: string | null; spend: number | null }[]).map((p) => ({
    source: p.source, startsOn: p.starts_on, endsOn: p.ends_on, spend: p.spend === null ? null : Number(p.spend),
  }));

  const rows = channelFunnel(channelLeads, promotions, from, today, today);

  // Contracts activated in the period that no lead can claim, for the trust panel.
  const { count: untraced } = await supabase.from("contracts").select("id", { count: "exact", head: true }).is("lead_id", null).gte("activated_at", fromIso);
  const traced = leads.length ? [...won].length : 0;

  const facts: TrustFacts = {
    tooFewChannels: rows.filter((r) => r.verdict.key === "too_few").length,
    totalChannels: rows.length,
    untracedDeals: untraced ?? 0,
    tracedDeals: traced,
    untouched: channelLeads.filter((l) => !l.firstTouchAt).length,
    enquiries: channelLeads.length,
    adChannelsWithoutSpend: rows.filter((r) => AD_SOURCES.includes(r.source) && r.enquiries >= TOO_FEW_TO_JUDGE && r.spend === 0).map((r) => sourceLabel(r.source, LEAD_SOURCE_LABELS)),
  };

  return NextResponse.json({
    days,
    from,
    to: today,
    truncated: leads.length >= MAX_LEADS,
    totals: {
      enquiries: channelLeads.length,
      junk: channelLeads.filter((l) => l.status === "junk").length,
      won: channelLeads.filter((l) => l.won).length,
    },
    rows: rows.map((r) => ({ ...r, label: sourceLabel(r.source, LEAD_SOURCE_LABELS) })),
    trust: trustLines(facts),
  });
}
