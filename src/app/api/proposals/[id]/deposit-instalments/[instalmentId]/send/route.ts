import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canRequestDepositInstalment } from "@/lib/deposit-instalments";
import { sendPartEmail } from "@/lib/deposit-instalment-email-server";

const MAX_CC = 10;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * POST /api/proposals/[id]/deposit-instalments/[instalmentId]/send
 *
 *   { preview: true }            → the email as the customer would see it; sends nothing.
 *   { additional_cc?: string[] } → emails the customer this part's request with the
 *                                  four-line breakup (required / paid / this part / balance).
 *
 * Creating a part does not message anyone; this is the deliberate send step.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; instalmentId: string }> },
) {
  const { id, instalmentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor || !canRequestDepositInstalment(actor.role)) {
    return NextResponse.json({ error: "Only an admin, manager or sales rep can send a deposit request" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { preview?: unknown; additional_cc?: unknown };
  const preview = body.preview === true;
  const cc = Array.isArray(body.additional_cc)
    ? Array.from(new Set(body.additional_cc.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()).filter(Boolean)))
    : [];
  const badCc = cc.filter((e) => !EMAIL_RE.test(e));
  if (badCc.length > 0) return NextResponse.json({ error: `Invalid CC address: ${badCc.join(", ")}` }, { status: 400 });
  if (cc.length > MAX_CC) return NextResponse.json({ error: `At most ${MAX_CC} CC addresses` }, { status: 400 });

  const admin = createAdminClient();
  // The part must belong to this proposal — the id in the URL is not trusted alone.
  const { data: part } = await admin
    .from("proposal_deposit_instalments").select("id, seq").eq("id", instalmentId).eq("proposal_id", id).maybeSingle();
  if (!part) return NextResponse.json({ error: "Deposit part not found" }, { status: 404 });

  const res = await sendPartEmail(admin, { instalmentId, kind: "request", preview, cc, sentBy: actor.id });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status ?? 500 });
  if (preview) return NextResponse.json({ preview: true, ...res.preview });

  void logAudit(admin, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: { deposit_part_request_emailed: { old: null, new: { seq: part.seq, to: res.sentTo } } },
  });
  return NextResponse.json({ data: { sent_to: res.sentTo, cc } });
}
