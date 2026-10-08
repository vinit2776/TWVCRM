import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { DEPOSIT_OVERRIDE_NOTE_MARKER, mentionsDeposit } from "@/lib/deposit-payment-guard";

/**
 * GET /api/accounting/deposit-review?days=90
 *
 * Detective control for the deposit-adjustment gate: payments recorded as a
 * plain mode ("Other", or any mode whose reference/notes talk about deposits
 * or adjustments) on a contract whose customer holds deposit. These are the
 * ones that look like a deposit adjustment that skipped the maker-checker
 * flow (TWV-C-0078, 2026-08). Payments the operator explicitly confirmed as
 * genuine receipts at the gate (the "[Not a deposit adjustment" note marker)
 * are left out.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const daysParam = Number(request.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 730) : 90;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const admin = createAdminClient();
  const { data: payments, error } = await admin
    .from("billing_payments")
    .select(
      "id, amount, payment_date, payment_mode, payment_reference, notes, " +
      "recorder:users!billing_payments_recorded_by_fkey(full_name), " +
      "statement:billing_statements!inner(id, statement_number, gst_invoice_number, contract_id)",
    )
    .neq("payment_mode", "deposit_adjustment")
    .gte("payment_date", since)
    .not("billing_statements.contract_id", "is", null)
    .order("payment_date", { ascending: false })
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string; amount: number; payment_date: string; payment_mode: string;
    payment_reference: string | null; notes: string | null;
    recorder: { full_name: string } | null;
    statement: {
      id: string; statement_number: string | null; gst_invoice_number: string | null;
      contract_id: string;
    };
  };

  const flagged = ((payments ?? []) as unknown as Row[]).filter((p) =>
    !(p.notes ?? "").includes(DEPOSIT_OVERRIDE_NOTE_MARKER) &&
    (p.payment_mode === "other" || mentionsDeposit(p.payment_reference, p.notes)),
  );

  // Only contracts whose customer actually holds deposit are worth a look.
  const contractIds = [...new Set(flagged.map((p) => p.statement.contract_id))];
  const collected = new Map<string, number>();
  await Promise.all(contractIds.map(async (cid) => {
    const { data } = await admin.rpc("get_deposit_available_balance", { p_contract_id: cid });
    collected.set(cid, Number(data?.[0]?.deposit_collected ?? 0));
  }));

  const { data: contracts } = contractIds.length
    ? await admin.from("contracts").select("id, contract_number").in("id", contractIds)
    : { data: [] };
  const numberById = new Map((contracts ?? []).map((c) => [c.id as string, c.contract_number as string]));

  const rows = flagged
    .filter((p) => (collected.get(p.statement.contract_id) ?? 0) > 0)
    .map((p) => ({
      payment_id: p.id,
      statement_id: p.statement.id,
      statement_number: p.statement.statement_number,
      gst_invoice_number: p.statement.gst_invoice_number,
      contract_id: p.statement.contract_id,
      contract_number: numberById.get(p.statement.contract_id) ?? null,
      amount: Number(p.amount),
      payment_date: p.payment_date,
      payment_mode: p.payment_mode,
      payment_reference: p.payment_reference,
      notes: p.notes,
      recorded_by: p.recorder?.full_name ?? null,
      deposit_collected: collected.get(p.statement.contract_id) ?? 0,
    }));

  return NextResponse.json({ days, count: rows.length, rows });
}
