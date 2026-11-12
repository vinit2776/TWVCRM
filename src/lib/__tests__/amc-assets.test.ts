import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { poIdsCoveringAsset } from "@/lib/procurement/amc-assets";

type Row = Record<string, unknown>;

// Just enough of the query builder for poIdsCoveringAsset: select / eq / neq / in, awaitable.
function fakeSupabase(db: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      let rows = [...(db[table] ?? [])];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
        in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        then: (resolve: (v: { data: Row[] }) => void) => resolve({ data: rows }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const db = {
  purchase_orders: [
    { id: "direct-live", po_type: "service", status: "ordered", linked_asset_id: "A" },
    { id: "direct-cancelled", po_type: "service", status: "cancelled", linked_asset_id: "A" },
    { id: "lines-live", po_type: "service", status: "pending", linked_asset_id: "other" },
    { id: "lines-cancelled", po_type: "service", status: "cancelled", linked_asset_id: "other" },
    { id: "elsewhere", po_type: "service", status: "ordered", linked_asset_id: "B" },
  ],
  purchase_order_items: [
    { po_id: "lines-live", linked_asset_id: "A" },
    { po_id: "lines-cancelled", linked_asset_id: "A" },
    { po_id: "direct-live", linked_asset_id: "A" },
    { po_id: "elsewhere", linked_asset_id: "B" },
  ],
};

describe("poIdsCoveringAsset", () => {
  it("returns live POs found through either link, once each", async () => {
    const ids = await poIdsCoveringAsset(fakeSupabase(db), "A");
    expect(ids.sort()).toEqual(["direct-live", "lines-live"]);
  });
  it("leaves out cancelled POs", async () => {
    const ids = await poIdsCoveringAsset(fakeSupabase(db), "A");
    expect(ids).not.toContain("direct-cancelled");
    expect(ids).not.toContain("lines-cancelled");
  });
  it("returns nothing when the asset only has cancelled POs", async () => {
    const onlyCancelled = {
      purchase_orders: [{ id: "x", po_type: "service", status: "cancelled", linked_asset_id: "C" }],
      purchase_order_items: [{ po_id: "x", linked_asset_id: "C" }],
    };
    expect(await poIdsCoveringAsset(fakeSupabase(onlyCancelled), "C")).toEqual([]);
  });
  it("returns nothing for an asset with no POs", async () => {
    expect(await poIdsCoveringAsset(fakeSupabase(db), "nobody")).toEqual([]);
  });
});
