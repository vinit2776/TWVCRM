/**
 * POST /api/tally/sync-pull
 *
 * Read-only bridge v2 endpoint. The bridge polls Tally on its own schedule
 * (every ~30 min during business hours), gathers voucher / receipt / party
 * snapshots, and POSTs them here. CRM is the sink — it never sends data
 * back upstream and never asks the bridge to write to Tally.
 *
 * Hard invariant: this endpoint MUST NOT write to Tally, schedule any
 * write, or surface any UI affordance for writing. The bridge is a
 * read-only mirror. Forever. See docs/tally-handoff-redesign.md §2.
 *
 * Auth: Bearer TALLY_AGENT_TOKEN (same as the other tally-bridge endpoints)
 * Company guard: x-tally-company header validated against app_settings.tally_locked_company
 *
 * Body:
 *   sync_batch_id: uuid — identifies this pull (so we can tell stale rows from fresh)
 *   company_name:  string — must match x-tally-company AND tally_locked_company
 *   vouchers:      array — sales / receipt / credit_note vouchers from Tally
 *   parties:       array — Sundry Debtor ledgers (optional; accepted but currently logged-only)
 *
 * Response:
 *   accepted:        number — voucher rows upserted into tally_voucher_snapshots
 *   matched:         number — vouchers matched to a billing_statement
 *   unmatched:       number — vouchers we couldn't link (kept anyway for CA reconciliation)
 *   auto_completed:  number — statements transitioned paid_awaiting_receipt_record → complete
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { setHandoffState } from "@/lib/tally-handoff-server";
import type { HandoffState } from "@/lib/tally-handoff";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VoucherSchema = z.object({
  voucher_master_id: z.string().min(1),
  voucher_kind: z.enum(["sales", "receipt", "credit_note"]),
  voucher_series: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  party_name: z.string().nullable().optional(),
  party_gstin: z.string().nullable().optional(),
  voucher_date: z.string().nullable().optional(),
  voucher_amount: z.number().nullable().optional(),
  irn: z.string().nullable().optional(),
  against_voucher: z.string().nullable().optional(),
  custom_fields: z.record(z.string(), z.unknown()).nullable().optional(),
});

const PartySchema = z.object({
  ledger_name: z.string(),
  gstin: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

const BodySchema = z.object({
  sync_batch_id: z.string().uuid(),
  company_name: z.string().min(1),
  vouchers: z.array(VoucherSchema).max(5000),
  parties: z.array(PartySchema).max(5000).optional().default([]),
});

function isAuthorised(request: NextRequest): boolean {
  const token = process.env.TALLY_AGENT_TOKEN;
  if (!token) return false; // refuse if not configured — never silently accept
  return request.headers.get("authorization") === `Bearer ${token}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse + validate body ────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid body", details: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const supabase = await createAdminClient();

  // ── Company guard (matches the existing /api/tally/* convention) ─────────
  const headerCompany = request.headers.get("x-tally-company") ?? "";
  const { data: lockedRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "tally_locked_company")
    .maybeSingle();
  const lockedCompany = (lockedRow?.value as string | undefined) ?? "";

  if (lockedCompany && (headerCompany !== lockedCompany || body.company_name !== lockedCompany)) {
    return NextResponse.json(
      {
        error: "Company guard failed",
        expected: lockedCompany,
        got_header: headerCompany,
        got_body: body.company_name,
      },
      { status: 409 },
    );
  }

  // ── Pre-fetch candidate statements for matching ──────────────────────────
  // Pull statements that could plausibly correspond to any voucher in this
  // batch. Scope: current + previous FY by voucher_date (cheap heuristic);
  // we don't need every historical statement.
  const earliestDate = body.vouchers
    .map((v) => v.voucher_date)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

  let candidateQuery = supabase
    .from("billing_statements")
    .select("id, gst_invoice_number, tally_invoice_number, handoff_state, period_start");

  if (earliestDate) {
    // 90-day lookback before the earliest voucher in the batch
    const lookbackDate = new Date(Date.parse(earliestDate) - 90 * 86_400_000)
      .toISOString().slice(0, 10);
    candidateQuery = candidateQuery.gte("period_start", lookbackDate);
  }

  const { data: candidatesRaw } = await candidateQuery;

  type Candidate = {
    id: string;
    gst_invoice_number: string | null;
    tally_invoice_number: string | null;
    handoff_state: HandoffState | null;
  };

  const candidates: Candidate[] = ((candidatesRaw || []) as unknown as Candidate[]);

  // Build lookup map keyed by both invoice number fields. CRM mirrors Tally's
  // number into both columns when accounts uploads via the inbox, so either
  // hits the same statement row.
  const byNumber = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.gst_invoice_number) byNumber.set(c.gst_invoice_number, c);
    if (c.tally_invoice_number) byNumber.set(c.tally_invoice_number, c);
  }

  // Match: exact-by-number only. Sales vouchers under v2 always carry a
  // number that CRM has mirrored, so the exact path catches the common case.
  // Vouchers raised directly in Tally (bypassing the inbox) come back
  // unmatched — that's the right signal: CA reconciliation can spot them.
  function matchSalesVoucher(v: z.infer<typeof VoucherSchema>): {
    statementId: string | null;
    confidence: "exact" | "unmatched";
  } {
    if (v.invoice_number) {
      const m = byNumber.get(v.invoice_number);
      if (m) return { statementId: m.id, confidence: "exact" };
    }
    return { statementId: null, confidence: "unmatched" };
  }

  // Receipts in Tally reference the sales voucher they clear via against_voucher.
  // We look that number up against the same byNumber map.
  function matchReceiptVoucher(v: z.infer<typeof VoucherSchema>): {
    statementId: string | null;
    confidence: "exact" | "unmatched";
  } {
    if (v.against_voucher) {
      const m = byNumber.get(v.against_voucher);
      if (m) return { statementId: m.id, confidence: "exact" };
    }
    return { statementId: null, confidence: "unmatched" };
  }

  // ── UPSERT vouchers ──────────────────────────────────────────────────────
  const upsertRows = body.vouchers.map((v) => {
    const match = v.voucher_kind === "receipt" ? matchReceiptVoucher(v) : matchSalesVoucher(v);
    return {
      voucher_master_id: v.voucher_master_id,
      company_name: body.company_name,
      voucher_kind: v.voucher_kind,
      voucher_series: v.voucher_series ?? null,
      invoice_number: v.invoice_number ?? null,
      party_name: v.party_name ?? null,
      party_gstin: v.party_gstin ?? null,
      voucher_date: v.voucher_date ?? null,
      voucher_amount: v.voucher_amount ?? null,
      irn: v.irn ?? null,
      against_voucher: v.against_voucher ?? null,
      custom_fields: v.custom_fields ?? {},
      matched_statement_id: match.statementId,
      match_confidence: match.confidence,
      last_synced_at: new Date().toISOString(),
      sync_batch_id: body.sync_batch_id,
    };
  });

  let upserted = 0;
  let matched = 0;
  let unmatched = 0;

  if (upsertRows.length > 0) {
    // Chunk to avoid massive single-statement payloads
    const CHUNK = 500;
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const slice = upsertRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("tally_voucher_snapshots")
        .upsert(slice, { onConflict: "voucher_master_id,company_name" });
      if (error) {
        return NextResponse.json(
          { error: `UPSERT failed at chunk ${i}: ${error.message}` },
          { status: 500 },
        );
      }
      upserted += slice.length;
      for (const r of slice) {
        if (r.matched_statement_id) matched += 1; else unmatched += 1;
      }
    }
  }

  // ── Receipt auto-complete ────────────────────────────────────────────────
  // For each receipt whose matched statement is in paid_awaiting_receipt_record,
  // transition the statement to complete. The bridge has seen the receipt in
  // Tally; accounts' job is done.
  let autoCompleted = 0;
  for (const row of upsertRows) {
    if (row.voucher_kind !== "receipt" || !row.matched_statement_id) continue;
    const statement = candidates.find((c) => c.id === row.matched_statement_id);
    if (statement?.handoff_state === "paid_awaiting_receipt_record") {
      await setHandoffState(supabase, row.matched_statement_id, "complete", "bridge_receipt_verified");
      autoCompleted += 1;
    }
  }

  // Party master snapshot — currently logged only. A future PR can add a
  // dedicated tally_party_snapshots table if name-match wants fresher data
  // than lead.gst_number provides.
  const partyCount = body.parties.length;

  return NextResponse.json({
    sync_batch_id: body.sync_batch_id,
    accepted: upserted,
    matched,
    unmatched,
    auto_completed: autoCompleted,
    parties_received: partyCount,
  });
}
