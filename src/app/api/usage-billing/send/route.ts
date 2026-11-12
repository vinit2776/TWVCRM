import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { sendPreparedUsageInvoice } from "@/lib/usage-billing";
import { errorStatus, requireUsageBillingUser } from "../auth";

export const maxDuration = 60;

const schema = z.object({ statement_id: z.string().uuid() });

/**
 * POST /api/usage-billing/send
 *
 * Step 2 of Review & send: finalizes a draft made by /prepare and sends it by
 * the contract's route (Proforma first or GST direct, via the same dispatch
 * functions as Finalize & Send). If sending fails before anything irreversible
 * happened, the draft is discarded and its charges return to the list.
 *
 * Outcome kinds: sent · handed_off (Tally Inbox / GST standby) ·
 * not_sent_released · not_delivered_kept.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUsageBillingUser();
  if ("response" in auth) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const outcome = await sendPreparedUsageInvoice(admin, parsed.data.statement_id, auth.userId);
  if ("error" in outcome) return NextResponse.json({ error: outcome.error.message, code: outcome.error.code }, { status: errorStatus(outcome.error.code) });

  logAudit(auth.supabase, {
    entityType: "billing_statement",
    entityId: parsed.data.statement_id,
    action: "update",
    performedBy: auth.userId,
    changes: { usage_invoice_send: { old: null, new: outcome } },
  });
  return NextResponse.json({ outcome });
}
