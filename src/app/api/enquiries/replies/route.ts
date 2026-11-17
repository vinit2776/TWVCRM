import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { enquiryMessages, type RawEnquiryRow } from "@/lib/enquiries";
import { waitingReply, waitTone, type WaitingReply, type WaitTone } from "@/lib/whatsapp-replies";

// GET /api/enquiries/replies — open WhatsApp enquiries where the customer has written since someone
// last acted on them, longest wait first. One row per conversation, not per message.
//   ?mine=true     only enquiries the caller has taken on
//   &summary=true  counts only, for the tab badge
// "Acted" is an update or the claim, because replies happen in the WhatsApp app and the CRM only
// learns of them when a person taps Replied. Read-only.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "User not found" }, { status: 403 });
  // The read-only viewer follows enquiry activity, never customers' numbers or messages.
  if (me.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sp = request.nextUrl.searchParams;
  const mine = sp.get("mine") === "true";
  const summaryOnly = sp.get("summary") === "true";

  type Row = {
    id: string;
    reference: string;
    lead_id: string | null;
    payload: RawEnquiryRow["payload"];
    received_at: string;
    claimed_by: string | null;
    claimed_at: string | null;
    lead: { first_name: string | null; last_name: string | null; mobile: string | null } | null;
    claimer: { full_name: string } | null;
  };

  const { data, error } = await supabase
    .from("lead_enquiries")
    .select(
      "id, reference, lead_id, payload, received_at, claimed_by, claimed_at, " +
        "lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name, mobile), " +
        "claimer:users!lead_enquiries_claimed_by_fkey(full_name)"
    )
    .eq("source", "whatsapp")
    .is("resolved_at", null)
    .not("claimed_by", "is", null)
    .order("received_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as unknown as Row[];

  // The latest thing a person logged on each, to measure the customer's messages against.
  const lastUpdate = new Map<string, string>();
  if (rows.length) {
    const { data: updates } = await createAdminClient()
      .from("enquiry_updates")
      .select("enquiry_id, created_at")
      .in("enquiry_id", rows.map((r) => r.id));
    for (const u of (updates ?? []) as { enquiry_id: string; created_at: string }[]) {
      if (u.created_at > (lastUpdate.get(u.enquiry_id) ?? "")) lastUpdate.set(u.enquiry_id, u.created_at);
    }
  }

  const now = Date.now();
  const waiting: { row: Row; reply: WaitingReply; tone: WaitTone }[] = [];
  for (const row of rows) {
    const lastStaffAt = [row.claimed_at, lastUpdate.get(row.id)].filter((t): t is string => !!t).sort().at(-1) ?? null;
    const reply = waitingReply(enquiryMessages(row.payload), lastStaffAt);
    if (reply) waiting.push({ row, reply, tone: waitTone(reply.waitingSince, now) });
  }
  waiting.sort((a, b) => a.reply.waitingSince.localeCompare(b.reply.waitingSince));

  const counts = { mine: waiting.filter((w) => w.row.claimed_by === me.id).length, all: waiting.length };
  if (summaryOnly) return NextResponse.json({ counts });

  const shown = mine ? waiting.filter((w) => w.row.claimed_by === me.id) : waiting;
  return NextResponse.json({
    counts,
    data: shown.map(({ row, reply, tone }) => ({
      id: row.id,
      reference: row.reference,
      lead_id: row.lead_id,
      name:
        `${row.lead?.first_name ?? ""} ${row.lead?.last_name === "-" ? "" : (row.lead?.last_name ?? "")}`.trim() ||
        row.payload?.name ||
        null,
      mobile_last4: (row.lead?.mobile ?? "").replace(/\D/g, "").slice(-4) || null,
      claimed_by_name: row.claimer?.full_name ?? null,
      mine: row.claimed_by === me.id,
      count: reply.count,
      quiet_count: reply.quietCount,
      waiting_since: reply.waitingSince,
      latest_text: reply.latestText,
      latest_at: reply.latestAt,
      tone,
    })),
  });
}
