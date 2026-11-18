import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { INBOUND_GROUPS, inboundGroupOf, websiteTriggerOf, type InboundGroup } from "@/lib/whatsapp-inbound-log";
import { last10Of } from "@/lib/whatsapp-gate";

// GET /api/whatsapp/inbound-log — inbound WhatsApp messages and what the CRM did with them.
//   By default only messages sent by one of the website's prefilled WhatsApp buttons;
//   &all=true     every inbound message on the number, for looking something up by hand
//   ?group=new|re_enquiry|follow_up|junk|held|ignored|other|untracked   (default: all)
//   &source=ad|direct       an ad reply, or a message typed straight to the number
//   &days=7                 look-back window (default 7, max 90)
//   &limit=100              rows returned (default 100, max 300)
// Counts per group cover the whole window, not just the rows returned. Read-only.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The read-only enquiry viewer follows enquiry activity, never customers' numbers or messages.
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (me.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sp = request.nextUrl.searchParams;
  const group = sp.get("group") as InboundGroup | null;
  if (group && !(INBOUND_GROUPS as readonly string[]).includes(group)) {
    return NextResponse.json({ error: "Unknown group" }, { status: 400 });
  }
  const source = sp.get("source");
  const days = Math.min(Math.max(parseInt(sp.get("days") || "7", 10) || 7, 1), 90);
  const limit = Math.min(Math.max(parseInt(sp.get("limit") || "100", 10) || 100, 1), 300);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  type Row = {
    id: string;
    created_at: string;
    from_number: string | null;
    message_body: string | null;
    template_name: string | null;
    entity_id: string | null;
    intake_outcome: string | null;
    intake_kind: string | null;
    enquiry_reference: string | null;
    is_ad_reply: boolean | null;
    ad_headline: string | null;
  };
  const COLUMNS =
    "id, created_at, from_number, message_body, template_name, entity_id, intake_outcome, intake_kind, enquiry_reference, is_ad_reply, ad_headline";

  const base = () => {
    let q = supabase
      .from("whatsapp_messages")
      .select(COLUMNS)
      .eq("direction", "inbound")
      .eq("channel", "whatsapp")
      .gte("created_at", since);
    if (source === "ad") q = q.eq("is_ad_reply", true);
    else if (source === "direct") q = q.eq("is_ad_reply", false);
    return q;
  };

  // The code can deploy before migration 00728: say so rather than show an empty log.
  const probe = await base().limit(1);
  if (probe.error) {
    return NextResponse.json({ error: "The inbound log is not set up on this database yet." }, { status: 503 });
  }

  // The window's rows are matched in code (the prefilled texts are a prefix rule, not a column), so
  // counts and rows come from one pass.
  const all = sp.get("all") === "true";
  const { data: windowRows, error } = await base().order("created_at", { ascending: false }).limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const kept = ((windowRows ?? []) as Row[])
    .map((r) => ({ r, trigger: websiteTriggerOf(r.message_body) }))
    .filter((x) => all || x.trigger);
  const counts: Record<InboundGroup, number> = { new: 0, re_enquiry: 0, follow_up: 0, junk: 0, held: 0, ignored: 0, other: 0, untracked: 0 };
  for (const { r } of kept) counts[inboundGroupOf(r.intake_outcome)] += 1;
  const shown = kept.filter(({ r }) => !group || inboundGroupOf(r.intake_outcome) === group).slice(0, limit);
  const rows = shown.map((x) => x.r);

  // Names and enquiry links. A number with no lead yet (held, ignored) shows as the number alone.
  const leadIds = [...new Set(rows.map((r) => r.entity_id).filter((x): x is string => !!x))];
  const references = [...new Set(rows.map((r) => r.enquiry_reference).filter((x): x is string => !!x))];
  const [{ data: leads }, { data: enquiries }] = await Promise.all([
    leadIds.length
      ? supabase.from("leads").select("id, first_name, last_name").in("id", leadIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null }[] }),
    references.length
      ? supabase.from("lead_enquiries").select("reference, lead_id").in("reference", references)
      : Promise.resolve({ data: [] as { reference: string; lead_id: string | null }[] }),
  ]);
  const nameOf = new Map(
    (leads ?? []).map((l) => [l.id, `${l.first_name ?? ""} ${l.last_name === "-" ? "" : l.last_name ?? ""}`.trim()])
  );
  const leadOfReference = new Map((enquiries ?? []).map((e) => [e.reference, e.lead_id]));

  const data_ = shown.map(({ r, trigger }) => {
    const outcome = r.intake_outcome;
    return {
      id: r.id,
      at: r.created_at,
      number_last10: r.from_number ? last10Of(r.from_number) : null,
      name: (r.entity_id && nameOf.get(r.entity_id)) || null,
      message: r.message_body,
      message_type: r.template_name,
      is_ad_reply: !!r.is_ad_reply,
      ad_headline: r.ad_headline,
      outcome,
      group: inboundGroupOf(outcome),
      website_trigger: trigger,
      reference: r.enquiry_reference,
      lead_id: (r.enquiry_reference && leadOfReference.get(r.enquiry_reference)) || r.entity_id || null,
    };
  });

  return NextResponse.json({ data: data_, counts, window_days: days });
}
