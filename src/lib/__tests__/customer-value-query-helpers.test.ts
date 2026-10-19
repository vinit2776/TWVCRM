import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  SnapshotQueryError,
  fetchAllPages,
  fetchInChunks,
  isMissingTableError,
  type PageResult,
} from "@/lib/customer-value/query-helpers";

/** A fake table of `total` numbered rows that serves pages the way PostgREST does. */
function table(total: number) {
  const calls: Array<[number, number]> = [];
  const serve = (from: number, to: number): PromiseLike<PageResult<number>> => {
    calls.push([from, to]);
    const data = Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => from + i);
    return Promise.resolve({ data, error: null });
  };
  return { serve, calls };
}

describe("fetchAllPages", () => {
  it("returns everything when it fits in one page", async () => {
    const t = table(7);
    expect(await fetchAllPages("rows", t.serve)).toHaveLength(7);
    expect(t.calls).toEqual([[0, PAGE_SIZE - 1]]);
  });

  it("keeps reading past the 1,000-row cap instead of silently stopping", async () => {
    const t = table(2350);
    const rows = await fetchAllPages("rows", t.serve);
    expect(rows).toHaveLength(2350);
    expect(rows[2349]).toBe(2349);
    expect(t.calls).toHaveLength(3);
  });

  it("makes one more request when a page is exactly full, to be sure nothing is left", async () => {
    const t = table(PAGE_SIZE);
    expect(await fetchAllPages("rows", t.serve)).toHaveLength(PAGE_SIZE);
    expect(t.calls).toHaveLength(2);
  });

  it("returns nothing for an empty table", async () => {
    expect(await fetchAllPages("rows", table(0).serve)).toEqual([]);
  });

  it("fails loudly, naming the read, instead of returning a partial result", async () => {
    await expect(
      fetchAllPages("statements", () => Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } }))
    ).rejects.toThrow(/statements: boom/);
  });
});

describe("fetchInChunks", () => {
  it("splits ids into chunks and drops duplicates", async () => {
    const seen: string[][] = [];
    const rows = await fetchInChunks<string>(
      "rows",
      ["a", "b", "a", "c", "d", "e"],
      (batch) => {
        seen.push(batch);
        return Promise.resolve({ data: batch, error: null });
      },
      2
    );
    expect(seen).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(rows.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not call the database for no ids", async () => {
    let called = false;
    const rows = await fetchInChunks<string>("rows", [], () => {
      called = true;
      return Promise.resolve({ data: [], error: null });
    });
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });

  it("pages within a chunk too", async () => {
    const t = table(1500);
    const rows = await fetchInChunks<number>("rows", ["x"], (_batch, from, to) => t.serve(from, to));
    expect(rows).toHaveLength(1500);
  });
});

describe("isMissingTableError", () => {
  it("recognises a table that does not exist, by code or message", () => {
    expect(isMissingTableError(new SnapshotQueryError("q", { message: "x", code: "42P01" }))).toBe(true);
    expect(isMissingTableError(new SnapshotQueryError("q", { message: "x", code: "PGRST205" }))).toBe(true);
    expect(isMissingTableError(new SnapshotQueryError("q", { message: 'relation "billing_queries" does not exist' }))).toBe(true);
  });
  it("does not mistake an ordinary failure for a missing table", () => {
    expect(isMissingTableError(new SnapshotQueryError("q", { message: "permission denied", code: "42501" }))).toBe(false);
    expect(isMissingTableError(new Error("does not exist"))).toBe(false);
  });
});
