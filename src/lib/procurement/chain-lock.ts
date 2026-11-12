// Closed-chain lock for procurement.
//
// A "chain" is everything one purchase cycle touched: an MR with all its POs and
// their bills; or, with no MR, a PO and its bills; or a standalone bill. When
// the whole chain is complete it becomes read-only after a grace period, and
// only an admin can reopen it (see procurement_chain_reopens, migration 00606).
//
// "Closed" is COMPUTED from the real records every time — never a stored flag —
// so it can't drift out of step with them. Only reopens are stored.
//
// CUT-OFF: only chains that completed on or after `lockEffectiveFrom`
// (app_settings.procurement_chain_lock_effective_from, set when the lock shipped)
// ever lock. Older ones stay correctable forever; so does everything if the
// setting is missing — the fail-safe direction.
//
// This file is the single source of truth for the rules; the pure
// `evaluateChain` is unit-tested, `loadChainInput` is the DB gatherer.

import { NextResponse } from "next/server";
import type { createClient } from "@/lib/supabase/server";
import { DEAD_BILL_STATUSES_FILTER, isDeadBillStatus } from "@/lib/constants";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** Days a complete chain stays correctable before it locks. */
export const CHAIN_LOCK_DELAY_DAYS = 7;
/** app_settings key holding the ISO timestamp from which chains may lock. */
export const CHAIN_LOCK_EFFECTIVE_FROM_KEY = "procurement_chain_lock_effective_from";
const DAY_MS = 86_400_000;

export type ChainRootType = "pr" | "po" | "bill";
export type ChainRef = { type: ChainRootType; id: string };

export type ChainInput = {
  root: ChainRef;
  pr: { status: string; approved_at: string | null; pr_number?: string } | null;
  pos: Array<{
    id: string;
    po_number?: string;
    po_type: string | null;
    status: string;
    advance_amount: number | null;
    advance_status: string | null;
    amc_end_date: string | null;
    amc_terminated_at: string | null;
    items: Array<{ quantity_ordered: number | string; quantity_received: number | string | null }>;
    lastReceiptAt: string | null;
  }>;
  bills: Array<{
    id: string;
    bill_number?: string;
    po_id: string | null;
    approval_status: string;
    payment_status: string;
    approved_at: string | null;
    lastPaymentAt: string | null;
  }>;
  tds: Array<{ bill_id: string; status: string; reversed_at: string | null; challanAt: string | null }>;
  /** Most recent reopen of this chain, if any. */
  lastReopenAt: string | null;
  /** Chains that completed before this never lock; null = the lock is not switched on. */
  lockEffectiveFrom: string | null;
};

export type ChainCondition = { key: "mr" | "received" | "approved" | "paid" | "tds"; label: string; done: boolean; detail: string };

export type ChainState = {
  state: "open" | "closing" | "locked";
  /** The chain was reopened by an admin and has not locked again yet. */
  reopened: boolean;
  /** When the last step finished (null while incomplete or undated). */
  completeSince: string | null;
  /** When it locks (closing) or locked (locked). */
  lockAt: string | null;
  /** Complete, but finished before the lock cut-off — correctable and never locks. */
  exempt: boolean;
  conditions: ChainCondition[];
};

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);
const latest = (xs: Array<number | null>) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.max(...v) : null;
};

export function evaluateChain(input: ChainInput, now: Date = new Date()): ChainState {
  const today = now.getTime();
  const liveBills = input.bills.filter((b) => !isDeadBillStatus(b.approval_status));
  // A cancelled PO is out of the chain; a withdrawn/rejected bill is too.
  const pos = input.pos.filter((p) => !["cancelled"].includes(p.status));
  const conditions: ChainCondition[] = [];

  // 1. The MR was approved and fully ordered.
  if (input.pr) {
    const done = input.pr.status === "po_created";
    conditions.push({
      key: "mr",
      label: "MR approved and fully ordered",
      done,
      detail: done ? "" : input.pr.status === "partially_ordered" ? "Part of the MR is still unordered" : `MR is ${input.pr.status.replace(/_/g, " ")}`,
    });
  }

  // 2. Goods received / service contract ended — and any advance paid.
  if (input.root.type !== "bill") {
    const notReceived: string[] = [];
    for (const p of pos) {
      const label = p.po_number ?? "PO";
      if (p.po_type === "service") {
        const ended = !!p.amc_terminated_at || (!!p.amc_end_date && new Date(p.amc_end_date).getTime() < today);
        if (!ended) notReceived.push(`${label} contract still running`);
      } else {
        const full = p.items.length > 0 && p.items.every((i) => Number(i.quantity_received ?? 0) >= Number(i.quantity_ordered));
        if (!full) notReceived.push(`${label} not fully received`);
      }
      if (Number(p.advance_amount ?? 0) > 0 && p.advance_status !== "processed") notReceived.push(`${label} advance not paid`);
    }
    if (pos.length === 0) notReceived.push("No purchase order yet");
    conditions.push({ key: "received", label: "All POs received (AMC: contract ended)", done: notReceived.length === 0, detail: notReceived.join(" · ") });
  }

  // 3. Every PO has a bill, and every live bill is approved.
  const unapproved: string[] = [];
  if (input.root.type !== "bill") {
    for (const p of pos) {
      if (!liveBills.some((b) => b.po_id === p.id)) unapproved.push(`${p.po_number ?? "PO"} has no bill yet`);
    }
  }
  for (const b of liveBills) if (b.approval_status !== "approved") unapproved.push(`${b.bill_number ?? "Bill"} awaiting approval`);
  if (liveBills.length === 0 && input.root.type === "bill") unapproved.push("No live bill");
  conditions.push({ key: "approved", label: "All bills approved", done: unapproved.length === 0, detail: unapproved.join(" · ") });

  // 4. Every live bill is paid in full.
  const unpaid = liveBills.filter((b) => b.payment_status !== "paid").map((b) => `${b.bill_number ?? "Bill"} ${b.payment_status === "partially_paid" ? "part-paid" : "unpaid"}`);
  conditions.push({ key: "paid", label: "All bills paid in full", done: liveBills.length > 0 && unpaid.length === 0, detail: unpaid.join(" · ") });

  // 5. Every TDS deduction on those bills is deposited.
  const billIds = new Set(liveBills.map((b) => b.id));
  const tdsOpen = input.tds.filter((t) => billIds.has(t.bill_id) && !t.reversed_at && t.status !== "deposited");
  conditions.push({
    key: "tds",
    label: "TDS deposited",
    done: tdsOpen.length === 0,
    detail: tdsOpen.length ? `${tdsOpen.length} TDS entr${tdsOpen.length === 1 ? "y" : "ies"} not on a challan yet` : "",
  });

  const allDone = conditions.every((c) => c.done);
  const lastReopen = ms(input.lastReopenAt);

  if (!allDone) {
    return { state: "open", reopened: lastReopen != null, completeSince: null, lockAt: null, exempt: false, conditions };
  }

  // The moment the last step finished (null for an undated legacy chain).
  const completeSince = latest([
    ms(input.pr?.approved_at),
    ...pos.map((p) => ms(p.lastReceiptAt)),
    ...pos.map((p) => (p.po_type === "service" ? ms(p.amc_terminated_at) ?? ms(p.amc_end_date) : null)),
    ...liveBills.map((b) => ms(b.approved_at)),
    ...liveBills.map((b) => ms(b.lastPaymentAt)),
    ...input.tds.filter((t) => billIds.has(t.bill_id) && !t.reversed_at).map((t) => ms(t.challanAt)),
  ]);

  // Finished before the cut-off (or undated, or no cut-off set): never locks.
  const effective = ms(input.lockEffectiveFrom);
  if (effective == null || completeSince == null || completeSince < effective) {
    return {
      state: "open",
      reopened: false,
      completeSince: completeSince != null ? new Date(completeSince).toISOString() : null,
      lockAt: null,
      exempt: true,
      conditions,
    };
  }

  // A reopen restarts the grace period, so an admin always gets a window to fix
  // things even if nothing new has been recorded yet.
  const lockAtMs = (latest([completeSince, lastReopen]) ?? 0) + CHAIN_LOCK_DELAY_DAYS * DAY_MS;
  const locked = today >= lockAtMs;
  return {
    state: locked ? "locked" : "closing",
    reopened: lastReopen != null && !locked && (completeSince == null || lastReopen >= completeSince),
    completeSince: completeSince != null ? new Date(completeSince).toISOString() : null,
    lockAt: new Date(lockAtMs).toISOString(),
    exempt: false,
    conditions,
  };
}

// ───────────────────────── database side ─────────────────────────

/** The chain a bill / PO / MR belongs to: its MR if it has one, else its PO, else itself. */
export async function resolveChainRoot(
  supabase: SupabaseClient,
  ref: { billId?: string; poId?: string; prId?: string }
): Promise<ChainRef | null> {
  let poId = ref.poId ?? null;
  let prId = ref.prId ?? null;
  if (ref.billId) {
    const { data: bill } = await supabase.from("vendor_bills").select("id, po_id").eq("id", ref.billId).maybeSingle();
    if (!bill) return null;
    if (!bill.po_id) return { type: "bill", id: bill.id };
    poId = bill.po_id;
  }
  if (poId && !prId) {
    const { data: po } = await supabase.from("purchase_orders").select("id, pr_id").eq("id", poId).maybeSingle();
    if (!po) return null;
    prId = po.pr_id ?? null;
    if (!prId) return { type: "po", id: po.id };
  }
  return prId ? { type: "pr", id: prId } : null;
}

export async function loadChainInput(supabase: SupabaseClient, root: ChainRef): Promise<ChainInput> {
  let pr: ChainInput["pr"] = null;
  let posRaw: Array<Record<string, unknown>> = [];
  let billsRaw: Array<Record<string, unknown>> = [];

  if (root.type === "pr") {
    const [{ data: prRow }, { data: poRows }] = await Promise.all([
      supabase.from("purchase_requests").select("status, approved_at, pr_number").eq("id", root.id).maybeSingle(),
      supabase.from("purchase_orders")
        .select("id, po_number, po_type, status, advance_amount, advance_status, amc_end_date, amc_terminated_at")
        .eq("pr_id", root.id),
    ]);
    pr = prRow ?? null;
    posRaw = poRows ?? [];
  } else if (root.type === "po") {
    const { data: poRows } = await supabase.from("purchase_orders")
      .select("id, po_number, po_type, status, advance_amount, advance_status, amc_end_date, amc_terminated_at")
      .eq("id", root.id);
    posRaw = poRows ?? [];
  }

  const poIds = posRaw.map((p) => p.id as string);
  const billSelect = "id, bill_number, po_id, approval_status, payment_status, approved_at";
  if (root.type === "bill") {
    const { data } = await supabase.from("vendor_bills").select(billSelect).eq("id", root.id);
    billsRaw = data ?? [];
  } else if (poIds.length) {
    const { data } = await supabase.from("vendor_bills").select(billSelect).in("po_id", poIds)
      .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
    billsRaw = data ?? [];
  }
  const billIds = billsRaw.map((b) => b.id as string);

  const [itemsRes, receiptsRes, paymentsRes, tdsRes, reopenRes, settingRes] = await Promise.all([
    poIds.length
      ? supabase.from("purchase_order_items").select("po_id, quantity_ordered, quantity_received").in("po_id", poIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    poIds.length
      ? supabase.from("po_delivery_receipts").select("po_id, received_at").in("po_id", poIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    billIds.length
      ? supabase.from("vendor_bill_payments").select("bill_id, created_at").in("bill_id", billIds).is("reversed_at", null)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    billIds.length
      ? supabase.from("vendor_bill_tds").select("bill_id, status, reversed_at, challan:tds_challans(created_at)").in("bill_id", billIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    supabase.from("procurement_chain_reopens").select("reopened_at").eq("root_type", root.type).eq("root_id", root.id)
      .order("reopened_at", { ascending: false }).limit(1),
    supabase.from("app_settings").select("value").eq("key", CHAIN_LOCK_EFFECTIVE_FROM_KEY).maybeSingle(),
  ]);

  const maxIso = (rows: Array<Record<string, unknown>> | null, key: string, field: string, id: string) => {
    let best: string | null = null;
    for (const r of rows ?? []) if (r[key] === id && typeof r[field] === "string" && (!best || (r[field] as string) > best)) best = r[field] as string;
    return best;
  };

  return {
    root,
    pr,
    pos: posRaw.map((p) => ({
      id: p.id as string,
      po_number: p.po_number as string,
      po_type: (p.po_type as string) ?? null,
      status: p.status as string,
      advance_amount: p.advance_amount != null ? Number(p.advance_amount) : null,
      advance_status: (p.advance_status as string) ?? null,
      amc_end_date: (p.amc_end_date as string) ?? null,
      amc_terminated_at: (p.amc_terminated_at as string) ?? null,
      items: (itemsRes.data ?? []).filter((i) => i.po_id === p.id) as ChainInput["pos"][number]["items"],
      lastReceiptAt: maxIso(receiptsRes.data ?? [], "po_id", "received_at", p.id as string),
    })),
    bills: billsRaw.map((b) => ({
      id: b.id as string,
      bill_number: b.bill_number as string,
      po_id: (b.po_id as string) ?? null,
      approval_status: b.approval_status as string,
      payment_status: b.payment_status as string,
      approved_at: (b.approved_at as string) ?? null,
      lastPaymentAt: maxIso(paymentsRes.data ?? [], "bill_id", "created_at", b.id as string),
    })),
    tds: (tdsRes.data ?? []).map((t) => {
      const ch = t.challan as unknown as { created_at: string } | { created_at: string }[] | null;
      const challanAt = Array.isArray(ch) ? ch[0]?.created_at ?? null : ch?.created_at ?? null;
      return { bill_id: t.bill_id as string, status: t.status as string, reversed_at: (t.reversed_at as string) ?? null, challanAt };
    }),
    lastReopenAt: (reopenRes.data?.[0]?.reopened_at as string) ?? null,
    // An unparseable value is treated as "not switched on".
    lockEffectiveFrom: (() => {
      const v = settingRes.data?.value as string | undefined;
      return v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null;
    })(),
  };
}

export async function getChainState(
  supabase: SupabaseClient,
  ref: { billId?: string; poId?: string; prId?: string }
): Promise<{ root: ChainRef; chain: ChainState } | null> {
  const root = await resolveChainRoot(supabase, ref);
  if (!root) return null;
  return { root, chain: evaluateChain(await loadChainInput(supabase, root)) };
}

/**
 * Route guard: a 423 response when the chain is locked, otherwise null.
 * Routes call this before any correction or money edit.
 */
export async function chainLockedResponse(
  supabase: SupabaseClient,
  ref: { billId?: string; poId?: string; prId?: string }
): Promise<NextResponse | null> {
  const found = await getChainState(supabase, ref);
  if (!found || found.chain.state !== "locked") return null;
  return NextResponse.json(
    {
      error: "This procurement cycle is closed and locked. An admin must reopen it before it can be changed.",
      code: "chain_locked",
    },
    { status: 423 }
  );
}
