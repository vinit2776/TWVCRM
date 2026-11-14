import { describe, it, expect } from "vitest";
import {
  billedToOf,
  requiresPaidInvoice,
  paymentGateAllows,
  type BilledTo,
  type PaymentOverride,
} from "@/lib/vo-execution-gate";

const override: PaymentOverride = { reason: "Owner approved, cheque in transit", by: "u1", at: "2026-01-01T00:00:00Z" };

describe("billedToOf", () => {
  it("is direct with no aggregator", () => {
    expect(billedToOf({ aggregatorId: null })).toBe("direct");
  });
  it("reads prepaid and postpaid from the aggregator", () => {
    expect(billedToOf({ aggregatorId: "a", billingMethod: "prepaid" })).toBe("prepaid");
    expect(billedToOf({ aggregatorId: "a", billingMethod: "postpaid" })).toBe("postpaid");
  });
  it("keeps an unset method distinct", () => {
    expect(billedToOf({ aggregatorId: "a", billingMethod: null })).toBe("unspecified");
  });
});

describe("requiresPaidInvoice (postpaid exemption)", () => {
  it("requires payment for direct and prepaid", () => {
    expect(requiresPaidInvoice("direct")).toBe(true);
    expect(requiresPaidInvoice("prepaid")).toBe(true);
  });
  it("exempts postpaid, and unset keeps the historical exemption", () => {
    expect(requiresPaidInvoice("postpaid")).toBe(false);
    expect(requiresPaidInvoice("unspecified")).toBe(false);
  });
});

describe("paymentGateAllows matrix", () => {
  const cases: BilledTo[] = ["direct", "prepaid", "postpaid"];
  for (const billedTo of cases) {
    for (const paid of [true, false]) {
      for (const withOverride of [true, false]) {
        const expected = billedTo === "postpaid" || paid || withOverride;
        it(`${billedTo} paid=${paid} override=${withOverride} -> ${expected}`, () => {
          expect(
            paymentGateAllows({ billedTo, paid, override: withOverride ? override : null }),
          ).toBe(expected);
        });
      }
    }
  }
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkVoExecutionPaymentGate } from "../vo-execution-gate";

type Fixture = {
  aggregatorId?: string | null;
  billingMethod?: string;
  voStatementPaid?: boolean;
  isRenewal?: boolean;
  startDate?: string | null;
  renewalBillPaid?: boolean;
};

// Minimal chainable stand-in for the three reads the gate makes.
function fakeSupabase(f: Fixture): SupabaseClient {
  const from = (table: string) => {
    const state = { cols: "" };
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = (c: string) => ((state.cols = c), q);
    q.eq = chain;
    q.is = chain;
    q.order = chain;
    q.limit = chain;
    const result = () => {
      if (table === "cases" && state.cols.includes("aggregator_id")) {
        return {
          aggregator_id: f.aggregatorId ?? null,
          aggregator: f.billingMethod ? { billing_method: f.billingMethod } : null,
        };
      }
      if (table === "cases") {
        return { is_renewal: !!f.isRenewal, start_date: f.startDate ?? null };
      }
      // billing_statements: vo_case lookup selects payment_status, renewal lookup selects id
      if (state.cols === "payment_status") {
        return { payment_status: f.voStatementPaid ? "paid" : "pending" };
      }
      return f.renewalBillPaid ? { id: "bill" } : null;
    };
    q.single = async () => ({ data: result() });
    q.maybeSingle = async () => ({ data: result() });
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

describe("checkVoExecutionPaymentGate (also guards starting e-sign)", () => {
  it("blocks a direct client whose invoice is unpaid", async () => {
    expect(await checkVoExecutionPaymentGate(fakeSupabase({}), "c1")).toMatch(/must be generated and paid/);
  });

  it("allows a direct client whose invoice is paid", async () => {
    expect(await checkVoExecutionPaymentGate(fakeSupabase({ voStatementPaid: true }), "c1")).toBeNull();
  });

  it("prepaid aggregator: initiating signing is blocked while unpaid (unchanged gate)", async () => {
    const sb = fakeSupabase({ aggregatorId: "a1", billingMethod: "prepaid" });
    expect(await checkVoExecutionPaymentGate(sb, "c1")).not.toBeNull();
  });

  it("postpaid aggregator: initiating signing is allowed while unpaid", async () => {
    const sb = fakeSupabase({ aggregatorId: "a1", billingMethod: "postpaid" });
    expect(await checkVoExecutionPaymentGate(sb, "c1")).toBeNull();
  });

  it("allows a renewal whose renewal bill is paid", async () => {
    const sb = fakeSupabase({ isRenewal: true, startDate: "2026-12-01", renewalBillPaid: true });
    expect(await checkVoExecutionPaymentGate(sb, "c1")).toBeNull();
  });
});
