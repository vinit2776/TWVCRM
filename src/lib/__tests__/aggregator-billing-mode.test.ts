import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/tally-handoff-server", () => ({ handleStatementFinalized: vi.fn() }));
vi.mock("@/lib/send-proforma", () => ({ dispatchProforma: vi.fn() }));

import { loadAggBillingMode } from "@/lib/aggregator-invoicing";

function client(value: unknown) {
  const calls: string[] = [];
  const builder = {
    select: () => builder,
    eq: (_col: string, key: string) => {
      calls.push(key);
      return builder;
    },
    maybeSingle: async () => ({ data: value === undefined ? null : { value }, error: null }),
  };
  return { supabase: { from: () => builder } as unknown as SupabaseClient, calls };
}

describe("loadAggBillingMode", () => {
  it("reads the setting row itself, so a flip applies to the next run", async () => {
    const { supabase, calls } = client("once_per_tenure");
    expect(await loadAggBillingMode(supabase)).toBe("once_per_tenure");
    expect(calls).toEqual(["vo_agg_billing_mode"]);
  });
  it("stays on legacy for any other value or a missing row", async () => {
    expect(await loadAggBillingMode(client("legacy").supabase)).toBe("legacy");
    expect(await loadAggBillingMode(client(undefined).supabase)).toBe("legacy");
    expect(await loadAggBillingMode(client("ONCE").supabase)).toBe("legacy");
  });
});
