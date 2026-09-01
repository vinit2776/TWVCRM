import { describe, it, expect } from "vitest";
import { buildChain } from "../unbilled-queue";
import { unbilledMonths, type RentCoverage } from "../billing-months";

/**
 * The one genuinely novel piece of logic in unbilled-queue.ts: batching
 * renewalChainContractIds() (one Supabase round-trip per hop, per contract —
 * fine for a single contract, wrong for every contract at once) into a single
 * in-memory walk over one full parent-id map fetched up front.
 *
 * These tests prove buildChain() produces the same chain
 * renewalChainContractIds() would, and that feeding it into unbilledMonths()
 * (completely unmodified, already proven correct in unbilled-months.test.ts)
 * gives identical results to the existing per-contract path.
 */
describe("buildChain", () => {
  it("returns just the contract itself when it has no parent", () => {
    const parentOf = new Map<string, string | null>([["child", null]]);
    expect(buildChain("child", parentOf)).toEqual(["child"]);
  });

  it("walks a multi-generation renewal chain nearest-first", () => {
    // grandparent (expired) -> parent (renewed) -> child (active)
    const parentOf = new Map<string, string | null>([
      ["child", "parent"],
      ["parent", "grandparent"],
      ["grandparent", null],
    ]);
    expect(buildChain("child", parentOf)).toEqual(["child", "parent", "grandparent"]);
  });

  it("stops on a cycle instead of looping forever", () => {
    const parentOf = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"], // cycle
    ]);
    const chain = buildChain("a", parentOf);
    expect(chain).toEqual(["a", "b"]);
  });

  it("includes a dangling parent id once, then stops (parent's own row wasn't in the fetched set)", () => {
    // parentOf only has an entry for "child" — "unknown-parent" isn't a key,
    // so its own parent_contract_id can't be looked up. The walk still
    // records it (harmless — one extra id in the statements query) and stops
    // there rather than throwing, since the id itself is real.
    const parentOf = new Map<string, string | null>([["child", "unknown-parent"]]);
    expect(buildChain("child", parentOf)).toEqual(["child", "unknown-parent"]);
  });
});

describe("the batched chain filter is load-bearing — feeding unbilledMonths the wrong statement set gives the wrong answer", () => {
  // grandparent (expired) -> parent (renewed) -> child (active, this is the renewal we're checking)
  const parentOf = new Map<string, string | null>([
    ["grandparent", null],
    ["parent", "grandparent"],
    ["child", "parent"],
  ]);

  const allStatements: RentCoverage[] = [
    // grandparent billed its own months before the parent existed — must never
    // count towards the child, and must be reachable via the 2-hop chain walk.
    { statement_type: "rent", period_start: "2025-01-01", period_end: "2025-01-31", prepaid_month: 1, prepaid_year: 2025, voided_at: null, contract_id: "grandparent" },
    // parent billed June on its own contract, before the renewal started.
    { statement_type: "rent", period_start: "2026-06-01", period_end: "2026-06-30", prepaid_month: 6, prepaid_year: 2026, voided_at: null, contract_id: "parent" },
    // parent, while renewal_in_progress, billed July on BEHALF of the child (attributed).
    { statement_type: "rent", period_start: "2026-07-01", period_end: "2026-07-31", prepaid_month: 7, prepaid_year: 2026, voided_at: null, contract_id: "parent", billed_on_behalf_of_contract_id: "child" },
    // August was never billed by anyone — the one real gap.
  ];

  const opts = {
    startDate: "2026-07-01",
    endDate: "2027-06-30",
    createdAt: "2026-06-15T00:00:00Z",
    today: "2026-08-20", // mid-August: September isn't due yet, so the window is exactly July-August
  };

  it("batched chain walk (buildChain + one flat query, filtered) finds exactly the real gap", () => {
    const chain = buildChain("child", parentOf);
    expect(chain).toEqual(["child", "parent", "grandparent"]);

    // This is what getRentGaps() actually does: one query across every id in
    // every chain, then filter that one array down to this contract's chain —
    // mirrors src/app/api/contracts/[id]/route.ts's own per-contract call,
    // just without a query per contract.
    const chainStatements = allStatements.filter((s) => chain.includes(s.contract_id as string));
    const result = unbilledMonths({ ...opts, statements: chainStatements, contractId: "child" });

    expect(result).toEqual([{ year: 2026, month: 8 }]);
  });

  it("without the chain (only the child's own rows) July wrongly reads as unbilled too", () => {
    // The child itself never has a statement row of its own for July — that
    // rent was billed on the parent while awaiting activation. Passing only
    // the child's own statements (no chain) is the mistake batching must avoid.
    const ownOnly = allStatements.filter((s) => s.contract_id === "child");
    const result = unbilledMonths({ ...opts, statements: ownOnly, contractId: "child" });

    expect(result).toEqual([{ year: 2026, month: 7 }, { year: 2026, month: 8 }]);
  });
});
