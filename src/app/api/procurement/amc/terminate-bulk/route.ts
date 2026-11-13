import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getChainState } from "@/lib/procurement/chain-lock";
import {
  BULK_TERMINATE_ROLES,
  TERMINATION_REASON_MIN,
  terminateBlocker,
  terminationPatch,
} from "@/lib/procurement/amc-terminate";

const bodySchema = z.object({
  po_ids: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().trim().min(TERMINATION_REASON_MIN, `Reason must be at least ${TERMINATION_REASON_MIN} characters`),
  // Fail safe: anything but an explicit false is a preview that changes nothing.
  preview: z.boolean().default(true),
});

type Row = Record<string, unknown>;

/**
 * POST /api/procurement/amc/terminate-bulk
 * Terminates the chosen AMCs in one go (admin only). Same effect as "Terminate AMC" on each
 * contract page: bills, payments, TDS and visit history stay as they are, and each can be
 * reinstated. `preview` (the default) reports what would happen and writes nothing.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !(BULK_TERMINATE_ROLES as readonly string[]).includes(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin can terminate AMCs in bulk" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  const { po_ids, reason, preview } = parsed.data;

  const { data: pos, error } = await supabase
    .from("purchase_orders")
    .select("id, po_number, po_type, status, amc_status, amc_start_date, amc_terminated_at, purchase_requests(expenditure_type)")
    .in("id", po_ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const found = new Map(((pos ?? []) as unknown as Row[]).map((p) => [p.id as string, p]));
  const results: Array<{ id: string; po_number: string | null; terminated: boolean; skipped_reason: string | null }> = [];

  for (const id of po_ids) {
    const po = found.get(id);
    if (!po) {
      results.push({ id, po_number: null, terminated: false, skipped_reason: "Not found" });
      continue;
    }
    const pr = po.purchase_requests as { expenditure_type?: string } | { expenditure_type?: string }[] | null;
    const requestIsAmc = (Array.isArray(pr) ? pr[0] : pr)?.expenditure_type === "amc";
    let blocker = terminateBlocker(
      {
        po_type: (po.po_type as string) ?? null,
        status: po.status as string,
        amc_terminated_at: (po.amc_terminated_at as string) ?? null,
        amc_start_date: (po.amc_start_date as string) ?? null,
        amc_status: (po.amc_status as string) ?? null,
      },
      requestIsAmc
    );
    // Same guard as a single termination: a closed, locked cycle needs an admin reopen first.
    if (!blocker) {
      try {
        const chain = await getChainState(supabase, { poId: id });
        if (chain?.chain.state === "locked") blocker = "Closed and locked — reopen the cycle first";
      } catch {
        // If the lock can't be read, fall through: the update below is still a plain flag.
      }
    }
    const base = { id, po_number: po.po_number as string };
    if (blocker) {
      results.push({ ...base, terminated: false, skipped_reason: blocker });
      continue;
    }
    if (preview) {
      results.push({ ...base, terminated: false, skipped_reason: null });
      continue;
    }

    const patch = terminationPatch(dbUser.id, reason);
    // The null check makes a double click or a parallel run a no-op rather than a re-stamp.
    const { data: updated, error: updateError } = await supabase
      .from("purchase_orders")
      .update(patch)
      .eq("id", id)
      .is("amc_terminated_at", null)
      .select("id");
    if (updateError || !updated?.length) {
      results.push({ ...base, terminated: false, skipped_reason: updateError?.message ?? "Already terminated" });
      continue;
    }
    await logAudit(supabase, {
      entityType: "purchase_order",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        amc_status: { old: po.amc_status, new: "terminated" },
        amc_terminated_at: { old: null, new: patch.amc_terminated_at },
        amc_termination_reason: { old: null, new: patch.amc_termination_reason },
        bulk_terminate: { old: null, new: true },
      },
    });
    results.push({ ...base, terminated: true, skipped_reason: null });
  }

  return NextResponse.json({
    data: {
      preview,
      results,
      summary: {
        requested: po_ids.length,
        eligible: results.filter((r) => !r.skipped_reason).length,
        terminated: results.filter((r) => r.terminated).length,
        skipped: results.filter((r) => r.skipped_reason).length,
      },
    },
  });
}
