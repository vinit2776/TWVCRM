import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isInboxRole } from "@/lib/tally-handoff";
import type { DepositInboxRow, DepositTopupCategory } from "@/types";

/**
 * GET /api/accounting/inbox/deposits?tab=open|closed
 *
 * Unified worklist for the Tally Inbox "Deposits" tab — combines original
 * proposal-stage security deposits with later deposit top-ups, since both
 * are money the accounts team needs to book against the same kind of Tally
 * ledger head. "closed" means the Tally receipt has been uploaded.
 */
export const dynamic = "force-dynamic";

function partyName(lead: { first_name?: string; last_name?: string; company?: string } | null) {
  if (!lead) return "(unknown party)";
  return lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(unnamed)";
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("role").eq("auth_id", user.id).maybeSingle();
  if (!isInboxRole(dbUser?.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tab = request.nextUrl.searchParams.get("tab") === "closed" ? "closed" : "open";
  const admin = createAdminClient();

  const { data: deposits } = await admin
    .from("proposals")
    .select(`
      id, proposal_number, deposit_payment_amount, deposit_payment_reference,
      deposit_payment_medium, deposit_payment_received_at,
      deposit_accounted, deposit_accounted_at, deposit_accounted_by, deposit_accounted_proof_path,
      lead:leads!proposals_lead_id_fkey(first_name, last_name, company),
      contract:contracts!contracts_proposal_id_fkey(contract_number)
    `)
    .eq("deposit_payment_status", "paid")
    .eq("deposit_accounted", tab === "closed");

  const { data: topups } = await admin
    .from("deposit_topups")
    .select(`
      id, amount, category, payment_mode, payment_reference, paid_at,
      accounted, accounted_at, accounted_by, accounted_proof_path,
      contract:contracts!deposit_topups_contract_id_fkey(
        contract_number,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
      )
    `)
    .eq("status", "paid")
    .eq("accounted", tab === "closed");

  const accountedByIds = Array.from(new Set([
    ...(deposits || []).map((d) => d.deposit_accounted_by).filter(Boolean),
    ...(topups || []).map((t) => t.accounted_by).filter(Boolean),
  ])) as string[];

  let namesById = new Map<string, string>();
  if (accountedByIds.length > 0) {
    const { data: users } = await admin.from("users").select("id, full_name").in("id", accountedByIds);
    namesById = new Map((users || []).map((u) => [u.id, u.full_name]));
  }

  const rows: DepositInboxRow[] = [
    ...(deposits || []).map((d): DepositInboxRow => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = d.lead as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = d.contract as any;
      return {
        id: d.id,
        kind: "deposit",
        party_name: partyName(lead),
        contract_number: contract?.contract_number ?? null,
        proposal_number: d.proposal_number,
        amount: d.deposit_payment_amount == null ? null : Number(d.deposit_payment_amount),
        payment_reference: d.deposit_payment_reference,
        payment_medium: d.deposit_payment_medium,
        paid_at: d.deposit_payment_received_at,
        accounted: !!d.deposit_accounted,
        accounted_at: d.deposit_accounted_at,
        accounted_by_name: d.deposit_accounted_by ? namesById.get(d.deposit_accounted_by) || null : null,
        proof_path: d.deposit_accounted_proof_path,
      };
    }),
    ...(topups || []).map((t): DepositInboxRow => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = t.contract as any;
      return {
        id: t.id,
        kind: "topup",
        party_name: partyName(contract?.lead ?? null),
        contract_number: contract?.contract_number ?? null,
        category: t.category as DepositTopupCategory,
        amount: t.amount == null ? null : Number(t.amount),
        payment_reference: t.payment_reference,
        payment_medium: t.payment_mode,
        paid_at: t.paid_at,
        accounted: !!t.accounted,
        accounted_at: t.accounted_at,
        accounted_by_name: t.accounted_by ? namesById.get(t.accounted_by) || null : null,
        proof_path: t.accounted_proof_path,
      };
    }),
  ].sort((a, b) => {
    const aTime = new Date((tab === "closed" ? (a.accounted_at || a.paid_at) : a.paid_at) || 0).getTime();
    const bTime = new Date((tab === "closed" ? (b.accounted_at || b.paid_at) : b.paid_at) || 0).getTime();
    return tab === "closed" ? bTime - aTime : aTime - bTime;
  });

  let openCount = rows.length;
  if (tab === "closed") {
    const { count: openDeposits } = await admin.from("proposals").select("id", { count: "exact", head: true })
      .eq("deposit_payment_status", "paid").eq("deposit_accounted", false);
    const { count: openTopups } = await admin.from("deposit_topups").select("id", { count: "exact", head: true })
      .eq("status", "paid").eq("accounted", false);
    openCount = (openDeposits ?? 0) + (openTopups ?? 0);
  }

  return NextResponse.json({ tab, rows, open_count: openCount });
}
