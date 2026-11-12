import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { voProposalColumnsPresent, VO_PROPOSAL_NOT_READY } from "@/lib/vo-proposal-server";
import {
  CUSTOMER_ACTION_STATUS,
  customerResponseBlockedReason,
  effectiveExpiry,
  isVoProposal,
} from "@/lib/vo-proposal";

// Public (token-gated, no session): the customer's view of a Virtual Office
// proposal and their answer to it. The token is an unguessable uuid; every read
// and write goes through the service role and is limited to that one row.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const responseSchema = z
  .object({
    action: z.enum(["accept", "request_changes", "decline"]),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.action !== "request_changes" || !!d.note, { message: "Tell us what you would like changed.", path: ["note"] });

const SELECT =
  "id, proposal_number, title, status, kind, items, subtotal, tax_percentage, tax_amount, discount_amount, total_amount, vo_term_months, vo_quoted_price, expires_at, sent_at, responded_at, lead_id, lead:leads!proposals_lead_id_fkey(first_name, last_name, company)";

async function load(token: string) {
  if (!UUID_RE.test(token)) return null;
  const { data } = await createAdminClient().from("proposals").select(SELECT).eq("public_token", token).maybeSingle();
  return data && isVoProposal(data) ? data : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await voProposalColumnsPresent())) return NextResponse.json({ error: VO_PROPOSAL_NOT_READY }, { status: 503 });
  const p = await load(token);
  if (!p) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });

  // Opening the page is the first sign the customer has seen it.
  if (p.status === "sent") {
    await createAdminClient()
      .from("proposals")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .eq("id", p.id)
      .eq("status", "sent");
    p.status = "viewed";
  }

  const lead = p.lead as unknown as { first_name?: string; last_name?: string; company?: string } | null;
  return NextResponse.json({
    data: {
      proposal_number: p.proposal_number,
      title: p.title,
      status: p.status,
      items: p.items,
      subtotal: p.subtotal,
      tax_percentage: p.tax_percentage,
      tax_amount: p.tax_amount,
      discount_amount: p.discount_amount,
      total_amount: p.total_amount,
      term_months: p.vo_term_months,
      expires_at: effectiveExpiry(p)?.toISOString() ?? null,
      customer_name: lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || null,
      blocked_reason: customerResponseBlockedReason(p),
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await voProposalColumnsPresent())) return NextResponse.json({ error: VO_PROPOSAL_NOT_READY }, { status: 503 });

  const parsed = responseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const p = await load(token);
  if (!p) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });

  const blocked = customerResponseBlockedReason(p);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  const { action, note } = parsed.data;
  const next = CUSTOMER_ACTION_STATUS[action];
  const now = new Date().toISOString();
  const admin = createAdminClient();

  // The status guard makes a double click, or a staff withdraw in the same
  // instant, lose cleanly instead of overwriting.
  const { data: updated } = await admin
    .from("proposals")
    .update({
      status: next,
      responded_at: now,
      response_note: note ?? null,
      ...(action === "accept" ? { accepted_at: now } : {}),
      ...(action === "decline" ? { rejected_at: now } : {}),
    })
    .eq("id", p.id)
    .in("status", ["sent", "viewed"])
    .select("id")
    .maybeSingle();
  if (!updated) {
    return NextResponse.json({ error: "This proposal changed while you were answering. Please reload the page." }, { status: 409 });
  }

  logAudit(admin, {
    entityType: "proposal",
    entityId: p.id,
    action: "update",
    performedBy: "customer",
    changes: {
      action: { old: null, new: `customer_${action}` },
      status: { old: p.status, new: next },
      ...(note ? { response_note: { old: null, new: note } } : {}),
    },
  });

  return NextResponse.json({ success: true, status: next });
}
