import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { prepareUsageInvoice } from "@/lib/usage-billing";
import { errorStatus, requireUsageBillingUser } from "../auth";

const schema = z.object({
  contract_id: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  charge_keys: z.array(z.string().regex(/^(manual|print|facility):[0-9a-f-]{36}$/)).min(1),
  expected_subtotal: z.number().positive(),
});

/**
 * POST /api/usage-billing/prepare
 *
 * Step 1 of Review & send for one contract-month: creates the draft invoice
 * and locks its charges to it (create_usage_invoice RPC). Sends nothing.
 * Refuses with 409 if the charges changed since the screen loaded.
 * The draft is then previewed with the existing preview-send and
 * proforma-pdf?preview=1 routes, and either sent (/send) or cancelled (/cancel).
 */
export async function POST(request: NextRequest) {
  const auth = await requireUsageBillingUser();
  if ("response" in auth) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  const admin = createAdminClient();
  const result = await prepareUsageInvoice(admin, {
    contractId: b.contract_id, year: b.year, month: b.month,
    chargeKeys: b.charge_keys, expectedSubtotal: b.expected_subtotal,
  });
  if ("error" in result) return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: errorStatus(result.error.code) });

  logAudit(auth.supabase, {
    entityType: "billing_statement",
    entityId: result.statementId,
    action: "create",
    performedBy: auth.userId,
    changes: {
      usage_invoice_prepared: { old: null, new: { contract_id: b.contract_id, month: `${b.year}-${String(b.month).padStart(2, "0")}`, charges: b.charge_keys.length, subtotal: b.expected_subtotal } },
    },
  });
  return NextResponse.json({ statement_id: result.statementId });
}
