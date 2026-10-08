import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { unverifiedPortionOfApplicable, type PoolDepositContractRow } from "@/lib/deposit-evidence";

// Same roles that manage contracts — the point is that sales / managers can
// unblock activation themselves, without an admin override.
const APPLY_ALLOWED_ROLES = ["admin", "manager", "sales_rep"];

type Applicable = {
  applicable: number;
  own_required: number;
  other_required: number;
  available: number;
  reason: string | null;
};

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 401 }) };

  if (!APPLY_ALLOWED_ROLES.includes(dbUser.role)) {
    return {
      error: NextResponse.json({
        error: "You do not have permission to apply a customer deposit to a contract. Please ask your manager or admin.",
      }, { status: 403 }),
    };
  }
  return { supabase, dbUser };
}

/**
 * GET /api/contracts/[id]/apply-pooled-deposit
 *
 * Read-only preview: how much of the customer's already-collected, unallocated
 * security deposit could be applied to this contract at activation.
 *
 * `unverified` is the part of `applicable` that rests only on deposits with no
 * real payment evidence (legacy "assumed received" imports, or paid with no
 * amount) — the page warns on it; it never blocks the apply.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorise();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("compute_pooled_deposit_applicable", { p_contract_id: id });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = (data?.[0] ?? null) as Applicable | null;
  const applicable = Number(row?.applicable ?? 0);

  let unverified: { amount: number; contract_numbers: string[] } = { amount: 0, contract_numbers: [] };
  if (applicable > 0) {
    const { data: thisContract } = await admin.from("contracts").select("lead_id").eq("id", id).single();
    if (thisContract?.lead_id) {
      const [{ data: contracts, error: contractsError }, { data: topups }, { data: adjustments }] = await Promise.all([
        admin.from("contracts")
          .select("contract_number, deposit_payment_status, deposit_payment_amount, security_deposit_amount, deposit_refunded_amount, deposit_payment_reference")
          .eq("lead_id", thisContract.lead_id),
        admin.from("deposit_topups").select("amount").eq("source_lead_id", thisContract.lead_id).eq("status", "paid"),
        admin.from("deposit_adjustments").select("amount").eq("source_lead_id", thisContract.lead_id).in("status", ["pending_approval", "approved"]),
      ]);
      // The warning is advisory: if its inputs can't be read, don't block the preview.
      if (contractsError) {
        console.error("[apply-pooled-deposit] evidence lookup failed:", contractsError.message);
      } else {
        const sum = (rows: { amount: number | null }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
        const portion = unverifiedPortionOfApplicable(
          (contracts ?? []) as PoolDepositContractRow[],
          applicable,
          Number(row?.other_required ?? 0),
          sum(topups),
          sum(adjustments)
        );
        unverified = { amount: portion.amount, contract_numbers: portion.contractNumbers };
      }
    }
  }

  return NextResponse.json({
    data: {
      applicable,
      required: Number(row?.own_required ?? 0),
      other_required: Number(row?.other_required ?? 0),
      available: Number(row?.available ?? 0),
      reason: row?.reason ?? null,
      unverified,
    },
  });
}

/**
 * POST /api/contracts/[id]/apply-pooled-deposit
 *
 * Records the customer's pooled deposit as covering this (not yet activated)
 * contract's security deposit, fully or partly. This is what unblocks the
 * deposit leg of the activation gate in PATCH /api/contracts/[id]. No money
 * moves — see supabase/migrations/00576_apply_pooled_deposit_at_activation.sql.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorise();
  if (auth.error) return auth.error;
  const { supabase, dbUser } = auth;

  const { data: before } = await supabase
    .from("contracts")
    .select("deposit_pool_applied_amount")
    .eq("id", id)
    .single();

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_pooled_deposit_to_contract", {
    p_contract_id: id,
    p_applied_by: dbUser.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = data?.[0] as
    | { success: boolean; error: string | null; applied_amount: number; own_required: number }
    | undefined;
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not apply the deposit" }, { status: 400 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      deposit_pool_applied_amount: {
        old: before?.deposit_pool_applied_amount ?? null,
        new: Number(result.applied_amount),
      },
    },
  });

  return NextResponse.json({
    data: {
      applied_amount: Number(result.applied_amount),
      required: Number(result.own_required),
      shortfall: Math.max(0, Number(result.own_required) - Number(result.applied_amount)),
    },
  });
}
