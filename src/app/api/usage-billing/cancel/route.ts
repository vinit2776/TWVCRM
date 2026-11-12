import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { cancelPreparedUsageInvoice } from "@/lib/usage-billing";
import { errorStatus, requireUsageBillingUser } from "../auth";

const schema = z.object({ statement_id: z.string().uuid() });

/**
 * POST /api/usage-billing/cancel
 *
 * Backs out of Review & send: discards a draft made by /prepare and returns
 * its charges to the unbilled list. Drafts only — nothing was sent.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUsageBillingUser();
  if ("response" in auth) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const result = await cancelPreparedUsageInvoice(admin, parsed.data.statement_id, auth.userId);
  if ("error" in result) return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: errorStatus(result.error.code) });

  logAudit(auth.supabase, {
    entityType: "billing_statement",
    entityId: parsed.data.statement_id,
    action: "update",
    performedBy: auth.userId,
    changes: { status: { old: "draft", new: "discarded" }, discard_reason: { old: null, new: "Cancelled from Review & send" } },
  });
  return NextResponse.json({ ok: true });
}
