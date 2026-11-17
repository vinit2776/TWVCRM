import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { loadWaitingReplies } from "@/lib/whatsapp-reply-queue";

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

  let waiting;
  try {
    waiting = await loadWaitingReplies(createAdminClient());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load replies" }, { status: 500 });
  }

  const counts = { mine: waiting.filter((w) => w.claimed_by === me.id).length, all: waiting.length };
  if (summaryOnly) return NextResponse.json({ counts });

  const shown = mine ? waiting.filter((w) => w.claimed_by === me.id) : waiting;
  return NextResponse.json({
    counts,
    data: shown.map((row) => ({
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
      count: row.reply.count,
      quiet_count: row.reply.quietCount,
      waiting_since: row.reply.waitingSince,
      latest_text: row.reply.latestText,
      latest_at: row.reply.latestAt,
      tone: row.tone,
    })),
  });
}
