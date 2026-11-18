import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getHoldoverClauseStatus, holdoverClauseBlockReason, isHoldoverClauseApproved } from "@/lib/vo-holdover-clause";

type Res = { data: unknown; error: { code?: string; message: string } | null };

function stub(tables: Record<string, Res | "throw">): SupabaseClient {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        const r = tables[table];
        if (r === "throw") throw new Error("boom");
        return r;
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const ok = (data: unknown): Res => ({ data, error: null });
const err = (code: string): Res => ({ data: null, error: { code, message: "x" } });

describe("getHoldoverClauseStatus", () => {
  it("approves when the current version has approved_at", async () => {
    const a = stub({ vo_clauses: ok({ id: "c1" }), vo_clause_versions: ok({ approved_at: "2026-11-01T00:00:00Z" }) });
    expect(await getHoldoverClauseStatus(a)).toEqual({ approved: true });
    expect(await isHoldoverClauseApproved(a)).toBe(true);
  });

  it("refuses an unapproved current version", async () => {
    const a = stub({ vo_clauses: ok({ id: "c1" }), vo_clause_versions: ok({ approved_at: null }) });
    expect(await getHoldoverClauseStatus(a)).toEqual({ approved: false, reason: "not_approved" });
  });

  it("refuses when the clause or its current version is missing", async () => {
    expect(await getHoldoverClauseStatus(stub({ vo_clauses: ok(null) }))).toEqual({ approved: false, reason: "no_current_version" });
    const a = stub({ vo_clauses: ok({ id: "c1" }), vo_clause_versions: ok(null) });
    expect(await getHoldoverClauseStatus(a)).toEqual({ approved: false, reason: "no_current_version" });
  });

  it.each(["42P01", "42703", "PGRST205", "PGRST204"])("reads %s as not migrated, not approved", async (code) => {
    expect(await getHoldoverClauseStatus(stub({ vo_clauses: err(code) }))).toEqual({ approved: false, reason: "not_migrated" });
    const a = stub({ vo_clauses: ok({ id: "c1" }), vo_clause_versions: err(code) });
    expect(await getHoldoverClauseStatus(a)).toEqual({ approved: false, reason: "not_migrated" });
  });

  it("fails closed on other errors and throws", async () => {
    expect(await getHoldoverClauseStatus(stub({ vo_clauses: err("XX000") }))).toEqual({ approved: false, reason: "lookup_failed" });
    expect(await isHoldoverClauseApproved(stub({ vo_clauses: "throw" }))).toBe(false);
  });
});

describe("holdoverClauseBlockReason", () => {
  it("is null when approved and a plain sentence otherwise", () => {
    expect(holdoverClauseBlockReason({ approved: true })).toBeNull();
    expect(holdoverClauseBlockReason({ approved: false, reason: "not_approved" })).toContain("T13");
  });
});
