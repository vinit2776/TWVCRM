import { describe, it, expect } from "vitest";
import {
  computeRequiresAdmin,
  billBlockerFromMessage,
  reimbursementBlocker,
  amcServiceEventsBlocker,
  processedAdvanceBlocker,
  buildBillVoidedEffect,
  buildPoCancelledEffect,
  buildStockReversedEffect,
  buildMrStatusEffect,
  resolveCancellationImpact,
} from "../procurement/cancellation-plan";

describe("billBlockerFromMessage", () => {
  it("names both the PO and the bill so an MR-level cancel is actionable", () => {
    const blocker = billBlockerFromMessage(
      "PO-2608-031",
      "BILL-2608-042",
      "Bill BILL-2608-042 has ₹31,400 recorded against it. Reverse the payment before voiding."
    );
    expect(blocker).not.toBeNull();
    expect(blocker!.entity).toBe("vendor_bill:BILL-2608-042");
    expect(blocker!.reason).toContain("PO-2608-031");
    expect(blocker!.reason).toContain("BILL-2608-042");
    expect(blocker!.reason).toContain("₹31,400");
  });

  it("returns null when the bill has no blocking message", () => {
    expect(billBlockerFromMessage("PO-1", "BILL-1", null)).toBeNull();
  });
});

describe("reimbursementBlocker", () => {
  it("blocks when the MR has an active (non-voided) reimbursement statement", () => {
    const blocker = reimbursementBlocker(true, "MR-2608-010");
    expect(blocker).not.toBeNull();
    expect(blocker!.entity).toBe("purchase_request:MR-2608-010");
  });

  it("does not block when there are no active statements", () => {
    expect(reimbursementBlocker(false, "MR-2608-010")).toBeNull();
  });
});

describe("amcServiceEventsBlocker", () => {
  it("blocks an active AMC PO with logged service events", () => {
    const blocker = amcServiceEventsBlocker({
      poNumber: "PO-2608-005",
      poType: "service",
      amcTerminatedAt: null,
      serviceEventCount: 3,
    });
    expect(blocker).not.toBeNull();
    expect(blocker!.reason).toContain("PO-2608-005");
    expect(blocker!.reason).toContain("Terminate the AMC first");
  });

  it("does not block a goods PO", () => {
    expect(
      amcServiceEventsBlocker({ poNumber: "PO-1", poType: "goods", amcTerminatedAt: null, serviceEventCount: 5 })
    ).toBeNull();
  });

  it("does not block once the AMC has already been terminated", () => {
    expect(
      amcServiceEventsBlocker({
        poNumber: "PO-1",
        poType: "service",
        amcTerminatedAt: "2026-01-01T00:00:00Z",
        serviceEventCount: 5,
      })
    ).toBeNull();
  });

  it("does not block a service PO with no logged events", () => {
    expect(
      amcServiceEventsBlocker({ poNumber: "PO-1", poType: "service", amcTerminatedAt: null, serviceEventCount: 0 })
    ).toBeNull();
  });
});

describe("processedAdvanceBlocker", () => {
  it("blocks a PO with a processed advance, naming the PO and the amount, and points at the Reverse advance action now that it exists", () => {
    const blocker = processedAdvanceBlocker({
      poNumber: "PO-2608-031",
      advanceStatus: "processed",
      advanceAmount: 15000,
    });
    expect(blocker).not.toBeNull();
    expect(blocker!.reason).toContain("PO-2608-031");
    expect(blocker!.reason).toContain("₹15,000");
    // Now that a "reverse_advance" action exists, the message must tell the
    // user to reverse the advance rather than punting to Finance manually.
    expect(blocker!.reason.toLowerCase()).toContain("reverse the advance");
    expect(blocker!.reason.toLowerCase()).not.toContain("click");
  });

  it("does not block a PO with no advance or a pending/rejected one", () => {
    expect(processedAdvanceBlocker({ poNumber: "PO-1", advanceStatus: null, advanceAmount: 0 })).toBeNull();
    expect(processedAdvanceBlocker({ poNumber: "PO-1", advanceStatus: "pending", advanceAmount: 5000 })).toBeNull();
    expect(processedAdvanceBlocker({ poNumber: "PO-1", advanceStatus: "not_required", advanceAmount: 0 })).toBeNull();
  });

  it("does not block a PO whose advance has been reversed (migration 00517) — this is the whole point of the reversal feature", () => {
    expect(processedAdvanceBlocker({ poNumber: "PO-1", advanceStatus: "reversed", advanceAmount: 15000 })).toBeNull();
  });
});

describe("computeRequiresAdmin", () => {
  it("requires admin when any bill in the chain is approved", () => {
    expect(
      computeRequiresAdmin({ rootType: "purchase_order", rootPrStatus: null, billApprovalStatuses: ["pending", "approved"] })
    ).toBe(true);
  });

  it("requires admin when the root MR is already post-approval", () => {
    expect(
      computeRequiresAdmin({ rootType: "purchase_request", rootPrStatus: "po_created", billApprovalStatuses: [] })
    ).toBe(true);
  });

  it("does not require admin for a draft/submitted MR root with no approved bills", () => {
    expect(
      computeRequiresAdmin({ rootType: "purchase_request", rootPrStatus: "submitted", billApprovalStatuses: ["pending"] })
    ).toBe(false);
  });
});

describe("effect builders", () => {
  it("builds a bill_voided effect with the amount formatted", () => {
    const effect = buildBillVoidedEffect("BILL-1", 12500);
    expect(effect.kind).toBe("bill_voided");
    expect(effect.detail).toContain("12,500");
  });

  it("builds a po_cancelled effect", () => {
    expect(buildPoCancelledEffect("PO-1").label).toContain("PO-1");
  });

  it("builds a stock_reversed effect including DC number, item, qty and location", () => {
    const effect = buildStockReversedEffect({ dcNumber: "DC-99", itemName: "A4 Paper", qty: 5, locationName: "HQ" });
    expect(effect.label).toContain("DC-99");
    expect(effect.detail).toContain("A4 Paper");
    expect(effect.detail).toContain("5");
    expect(effect.detail).toContain("HQ");
  });

  it("builds an mr_status effect describing the terminal status", () => {
    expect(buildMrStatusEffect("MR-1", "submitted").label).toMatch(/Pending Approval/);
    expect(buildMrStatusEffect("MR-1", "cancelled").label).toMatch(/Cancelled/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The single most important invariant of this feature: a chain containing
// a paid bill (or, per the later product decision, a PO with a processed
// advance) must produce a blocker and therefore never reach the RPC. These
// tests exercise resolveCancellationImpact end-to-end against a minimal
// fake Supabase client, so the guarantee can't regress silently even if
// call sites stop wiring the blocker check up correctly.
// ─────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Minimal fake of the subset of the Supabase query builder this resolver
 * uses (.from().select().eq()... terminated by .single() / .maybeSingle() /
 * count). Table contents are supplied as plain arrays; filters are applied
 * in-memory. This is intentionally narrow — just enough to drive
 * resolveCancellationImpact without a real database.
 */
function makeFakeSupabase(tables: Record<string, Row[]>) {
  // `any` here is deliberate: this is a hand-rolled structural fake of the
  // narrow slice of the Supabase query builder resolveCancellationImpact
  // uses (select/eq/neq/is, then single()/maybeSingle()/awaited-as-thenable
  // for count queries). Typing it against the real (very large, generic)
  // PostgrestQueryBuilder type isn't worth it for a test-only double — the
  // call site casts the whole object to the real SupabaseClient type via
  // `unknown` anyway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function builder(table: string): any {
    let rows = tables[table] ?? [];
    let wantCount = false;
    const api = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        return api;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return api;
      },
      neq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] !== val);
        return api;
      },
      is(col: string, val: unknown) {
        rows = rows.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return api;
      },
      async maybeSingle() {
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } };
      },
      then(resolve: (v: { data: Row[] | null; count: number | null; error: null }) => unknown) {
        // Support `await` directly on the builder (no terminal method
        // called) the way `.select(..., { count, head: true })` is used.
        return Promise.resolve({ data: wantCount ? null : rows, count: wantCount ? rows.length : null, error: null }).then(resolve);
      },
    };
    return api;
  }

  return {
    from(table: string) {
      return builder(table);
    },
  };
}

describe("resolveCancellationImpact — paid bill blocks the whole chain", () => {
  it("blocks an MR-root cancel when one bill under one of its POs has a recorded payment", async () => {
    const tables: Record<string, Row[]> = {
      purchase_requests: [{ id: "pr-1", pr_number: "MR-2608-010", status: "po_created", department: "operational" }],
      billing_statements: [],
      purchase_orders: [
        { id: "po-1", po_number: "PO-2608-031", po_type: "goods", status: "ordered", pr_id: "pr-1", location_id: null, advance_status: "not_required", advance_amount: null, amc_terminated_at: null },
      ],
      amc_service_events: [],
      vendor_bills: [
        { id: "bill-1", bill_number: "BILL-2608-042", po_id: "po-1", approval_status: "approved", total_amount: 31400, amount_paid: 31400 },
      ],
      vendor_bill_payments: [{ bill_id: "bill-1", amount: 31400 }],
      vendor_bill_tds: [],
      po_delivery_receipts: [],
    };
    const supabase = makeFakeSupabase(tables) as unknown as Parameters<typeof resolveCancellationImpact>[0];

    const impact = await resolveCancellationImpact(supabase, {
      rootType: "purchase_request",
      rootId: "pr-1",
      outcome: "cancelled",
      reason: "Test: wrong vendor selected on this MR",
    });

    expect(impact.blockers.length).toBeGreaterThan(0);
    expect(impact.blockers.some((b) => b.reason.includes("PO-2608-031") && b.reason.includes("BILL-2608-042"))).toBe(true);
    // The plan must be unusable — no vendor bill or PO makes it into the
    // plan while a blocker exists for this chain, since call sites refuse
    // to invoke the RPC whenever `blockers` is non-empty.
    expect(impact.plan.vendor_bills).toHaveLength(0);
  });

  it("blocks when a PO in the chain has a processed advance, without emitting an advance_recovery effect", async () => {
    const tables: Record<string, Row[]> = {
      purchase_requests: [{ id: "pr-2", pr_number: "MR-2608-011", status: "approved", department: "operational" }],
      billing_statements: [],
      purchase_orders: [
        { id: "po-2", po_number: "PO-2608-032", po_type: "goods", status: "ordered", pr_id: "pr-2", location_id: null, advance_status: "processed", advance_amount: 15000, amc_terminated_at: null },
      ],
      amc_service_events: [],
      vendor_bills: [],
      vendor_bill_payments: [],
      vendor_bill_tds: [],
      po_delivery_receipts: [],
    };
    const supabase = makeFakeSupabase(tables) as unknown as Parameters<typeof resolveCancellationImpact>[0];

    const impact = await resolveCancellationImpact(supabase, {
      rootType: "purchase_request",
      rootId: "pr-2",
      outcome: "revoked",
      reason: "Test: approval was premature",
    });

    expect(impact.blockers.some((b) => b.reason.includes("PO-2608-032") && b.reason.includes("15,000"))).toBe(true);
    expect(impact.effects.every((e) => (e.kind as string) !== "advance_recovery")).toBe(true);
    expect(impact.plan.advance_recoveries).toHaveLength(0);
  });

  it("does NOT block when the PO's advance has been reversed — proves the Reverse advance action actually unblocks cancellation", async () => {
    const tables: Record<string, Row[]> = {
      purchase_requests: [{ id: "pr-3", pr_number: "MR-2608-012", status: "approved", department: "operational" }],
      billing_statements: [],
      purchase_orders: [
        { id: "po-3", po_number: "PO-2608-033", po_type: "goods", status: "ordered", pr_id: "pr-3", location_id: null, advance_status: "reversed", advance_amount: 15000, amc_terminated_at: null },
      ],
      amc_service_events: [],
      vendor_bills: [],
      vendor_bill_payments: [],
      vendor_bill_tds: [],
      po_delivery_receipts: [],
    };
    const supabase = makeFakeSupabase(tables) as unknown as Parameters<typeof resolveCancellationImpact>[0];

    const impact = await resolveCancellationImpact(supabase, {
      rootType: "purchase_request",
      rootId: "pr-3",
      outcome: "cancelled",
      reason: "Test: advance was reversed via refund, cancel now proceeds",
    });

    expect(impact.blockers).toHaveLength(0);
    expect(impact.plan.purchase_orders).toHaveLength(1);
  });
});
