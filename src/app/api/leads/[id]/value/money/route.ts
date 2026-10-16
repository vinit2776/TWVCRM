/**
 * GET /api/leads/[id]/value/money
 *
 * Money sub-tab of the lead's Value tab (docs/customer-value-tab-spec.md,
 * sections 5.2 and 5.3): lifetime revenue and collection, payment promptness
 * per invoice, and the concessions ledger (rent waivers, billing moratoriums,
 * booking waivers and refunds, credit notes).
 *
 * Read-only. Computed on read from the lead's statements, payments and
 * concession records; sends nothing to any customer and writes nothing.
 * "Paid" is the repo-wide definition in src/lib/settlement.ts (cash + TDS).
 *
 * Several small queries run in parallel rather than one snapshot read: this
 * phase has no snapshot tables yet (phase 2 adds them), and the rows per
 * customer are modest. Chunked `in` lookups keep URLs short for long-standing
 * customers.
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { contractRan, rentStepsForContract, todayYmdIst } from "@/lib/customer-value/journey";
import { loadLeadContracts } from "@/lib/customer-value/load-contracts";
import {
  buildMoney,
  type MoneyConcessionInput,
  type MoneyPaymentRow,
  type MoneyStatementRow,
} from "@/lib/customer-value/money";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

const STATEMENT_COLUMNS =
  "id, statement_number, gst_invoice_number, statement_type, period_start, period_end, subtotal, " +
  "tax_amount, total_amount, status, due_date, reminder_count";

const CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

/** Runs one `in (...)` lookup per chunk of ids and concatenates the rows. */
async function inChunks<T>(
  ids: string[],
  run: (batch: string[]) => PromiseLike<QueryResult<T>>
): Promise<{ rows: T[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null };
  const results = await Promise.all(chunk(ids, CHUNK).map((batch) => run(batch)));
  const failed = results.find((r) => r.error);
  if (failed?.error) return { rows: [], error: failed.error.message };
  return { rows: results.flatMap((r) => r.data ?? []), error: null };
}

async function loadAdminRole(supabase: SupabaseClient, authId: string): Promise<string | null> {
  const { data } = await supabase.from("users").select("role").eq("auth_id", authId).single();
  return data?.role ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await loadAdminRole(supabase, user.id)) !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const fail = (what: string, message: string) => {
    console.error(`[api/leads/value/money] ${what} query failed:`, message);
    return NextResponse.json({ error: "Failed to load money" }, { status: 500 });
  };

  // Round 1: everything keyed directly by the lead.
  const [loaded, statementsRes, bookingsRes] = await Promise.all([
    loadLeadContracts(supabase, leadId),
    supabase
      .from("billing_statements")
      .select(STATEMENT_COLUMNS)
      .eq("lead_id", leadId)
      .returns<MoneyStatementRow[]>(),
    supabase.from("bookings").select("id").eq("lead_id", leadId).returns<Array<{ id: string }>>(),
  ]);
  if ("error" in loaded) return fail("contracts", loaded.error);
  if (statementsRes.error) return fail("statements", statementsRes.error.message);
  if (bookingsRes.error) return fail("bookings", bookingsRes.error.message);

  const contracts = loaded.contracts;
  const statements = statementsRes.data ?? [];
  const contractIds = contracts.map((c) => c.id);
  const statementIds = statements.map((s) => s.id);
  const bookingIds = (bookingsRes.data ?? []).map((b) => b.id);

  // Round 2: records keyed by round 1's ids.
  const [payments, creditNotes, rentWaivers, moratoriums, bookingWaivers, refunds] = await Promise.all([
    inChunks<MoneyPaymentRow>(statementIds, (batch) =>
      supabase
        .from("billing_payments")
        .select("billing_statement_id, amount, tds_amount, payment_date, created_at")
        .in("billing_statement_id", batch)
        .returns<MoneyPaymentRow[]>()
    ),
    inChunks<MoneyConcessionInput["creditNotes"][number]>(statementIds, (batch) =>
      supabase
        .from("credit_note_uploads")
        .select("credit_note_amount, credit_note_date, credit_note_number, reason, superseded_by")
        .in("billing_statement_id", batch)
        .returns<MoneyConcessionInput["creditNotes"]>()
    ),
    inChunks<MoneyConcessionInput["rentWaivers"][number]>(contractIds, (batch) =>
      supabase
        .from("contract_rent_waivers")
        .select("contract_id, waived_month, reason, revoked_at")
        .in("contract_id", batch)
        .returns<MoneyConcessionInput["rentWaivers"]>()
    ),
    inChunks<MoneyConcessionInput["moratoriums"][number]>(contractIds, (batch) =>
      supabase
        .from("contract_billing_moratoriums")
        .select("contract_id, moratorium_month, reason, status, overridden_at")
        .in("contract_id", batch)
        .returns<MoneyConcessionInput["moratoriums"]>()
    ),
    inChunks<MoneyConcessionInput["bookingWaivers"][number]>(bookingIds, (batch) =>
      supabase
        .from("waiver_requests")
        .select("waiver_type, waiver_amount, status, approved_at, created_at, note")
        .in("booking_id", batch)
        .returns<MoneyConcessionInput["bookingWaivers"]>()
    ),
    inChunks<MoneyConcessionInput["refunds"][number]>(bookingIds, (batch) =>
      supabase
        .from("refund_requests")
        .select("amount_requested, status, processed_at, requested_at, reason")
        .in("booking_id", batch)
        .returns<MoneyConcessionInput["refunds"]>()
    ),
  ]);

  const failure = [
    ["payments", payments],
    ["credit notes", creditNotes],
    ["rent waivers", rentWaivers],
    ["moratoriums", moratoriums],
    ["booking waivers", bookingWaivers],
    ["refunds", refunds],
  ].find(([, r]) => (r as { error: string | null }).error);
  if (failure) return fail(failure[0] as string, (failure[1] as { error: string }).error);

  const money = buildMoney({
    statements,
    payments: payments.rows,
    concessions: {
      rentWaivers: rentWaivers.rows,
      moratoriums: moratoriums.rows,
      bookingWaivers: bookingWaivers.rows,
      refunds: refunds.rows,
      creditNotes: creditNotes.rows,
      contractNumbers: Object.fromEntries(contracts.map((c) => [c.id, c.contract_number])),
    },
    rentSteps: contracts.filter(contractRan).flatMap(rentStepsForContract),
    today: todayYmdIst(),
  });

  return NextResponse.json(
    { money },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
  );
}
