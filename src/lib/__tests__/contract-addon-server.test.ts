import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeSyncReport, syncStatementsForAddonChange } from "../contract-addon-server";
import type { AddonTerms } from "../addon-billing";

type Row = Record<string, unknown>;

/** Just enough of the query builder for syncStatementsForAddonChange. */
function stubClient(statements: Row[]) {
  const updates: { id: unknown; values: Row }[] = [];
  const builder = (rows: Row[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "gte", "lte"]) chain[m] = () => chain;
    chain.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null });
    return chain;
  };
  const client = {
    from: () => ({
      select: () => builder(statements),
      update: (values: Row) => {
        let id: unknown;
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: unknown) => {
          if (col === "id") id = val;
          return chain;
        };
        chain.is = () => {
          updates.push({ id, values });
          return Promise.resolve({ error: null });
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, updates };
}

const valet: AddonTerms = {
  description: "Valet car parking",
  amount: 7000,
  effective_from: "2026-11-19",
  effective_until: "2027-05-18",
  is_active: true,
};

const statement = (over: Row = {}): Row => ({
  id: "s1",
  statement_number: "BS-0100",
  status: "draft",
  proforma_sent_at: null,
  period_start: "2027-01-01",
  period_end: "2027-01-31",
  subtotal: 43252,
  fixed_amount: 43252,
  tax_percentage: 18,
  line_items: [
    {
      type: "prepaid_rent",
      label: "Prepaid Rent — Jan 2027",
      items: [
        { description: "Private cabin", amount: 36252 },
        { description: "Valet car parking", amount: 7000 },
      ],
      subtotal: 43252,
    },
  ],
  ...over,
});

describe("syncStatementsForAddonChange", () => {
  it("corrects an unsent draft and recomputes GST when an add-on is paused", async () => {
    const { client, updates } = stubClient([statement()]);
    const report = await syncStatementsForAddonChange(client, "c1", valet, { ...valet, is_active: false });
    expect(report.updated).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      subtotal: 36252,
      fixed_amount: 36252,
      tax_amount: 6525.36,
      cgst_amount: 3262.68,
      sgst_amount: 3262.68,
      igst_amount: 0,
      total_amount: 42777,
    });
  });

  it("never edits an issued invoice, only reports it", async () => {
    const { client, updates } = stubClient([statement({ status: "finalized", proforma_sent_at: "2027-01-02T00:00:00Z" })]);
    const report = await syncStatementsForAddonChange(client, "c1", valet, { ...valet, effective_until: "2027-01-14" });
    expect(updates).toHaveLength(0);
    expect(report.issued).toHaveLength(1);
    expect(report.updated).toHaveLength(0);
  });

  it("asks for a check when a draft spans several months", async () => {
    const { client, updates } = stubClient([statement({ period_start: "2027-01-01", period_end: "2027-03-31" })]);
    const report = await syncStatementsForAddonChange(client, "c1", valet, { ...valet, is_active: false });
    expect(updates).toHaveLength(0);
    expect(report.needsReview).toHaveLength(1);
  });

  it("leaves a statement alone when the add-on was never on it", async () => {
    const noValet = statement({
      subtotal: 36252,
      fixed_amount: 36252,
      line_items: [{ label: "Prepaid Rent — Jan 2027", items: [{ description: "Private cabin", amount: 36252 }], subtotal: 36252 }],
    });
    const { client, updates } = stubClient([noValet]);
    const report = await syncStatementsForAddonChange(client, "c1", { ...valet, is_active: false }, { ...valet, is_active: false, description: "Valet car parking" });
    expect(updates).toHaveLength(0);
    expect(report).toEqual({ updated: [], needsReview: [], issued: [] });
  });
});

describe("describeSyncReport", () => {
  it("says nothing when no statement was touched", () => {
    expect(describeSyncReport({ updated: [], needsReview: [], issued: [] })).toBeNull();
    expect(
      describeSyncReport({
        updated: [{ statement_number: "BS-0100", period_start: "2027-01-01", period_end: "2027-01-31", status: "draft" }],
        needsReview: [],
        issued: [],
      })
    ).toBeNull();
  });

  it("names the invoices that were already issued", () => {
    const text = describeSyncReport({
      updated: [],
      needsReview: [],
      issued: [{ statement_number: "BS-0099", period_start: "2026-12-01", period_end: "2026-12-31", status: "finalized" }],
    });
    expect(text).toContain("BS-0099");
    expect(text).toContain("not changed");
  });
});
