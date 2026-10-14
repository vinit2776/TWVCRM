import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUser = vi.fn();
const single = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single }) }) }),
  }),
}));

import { getDashboardAuth, runInDashboardBatch } from "@/lib/dashboard-auth";
import { dashboardFetch } from "@/lib/dashboard-fetch";

describe("getDashboardAuth", () => {
  beforeEach(() => {
    getUser.mockReset().mockResolvedValue({ data: { user: { id: "auth-1" } } });
    single.mockReset().mockResolvedValue({ data: { id: "u1", role: "admin" } });
  });

  it("looks the session up once per batch, however many routes ask", async () => {
    const results = await runInDashboardBatch(() =>
      Promise.all(Array.from({ length: 20 }, () => getDashboardAuth()))
    );
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.dbUser?.role === "admin")).toBe(true);
  });

  it("does not share a lookup across separate batches or standalone calls", async () => {
    await runInDashboardBatch(() => getDashboardAuth());
    await runInDashboardBatch(() => getDashboardAuth());
    await getDashboardAuth();
    expect(getUser).toHaveBeenCalledTimes(3);
  });

  it("returns no user and skips the users lookup when signed out", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const auth = await getDashboardAuth();
    expect(auth).toEqual({ user: null, dbUser: null });
    expect(single).not.toHaveBeenCalled();
  });
});

describe("dashboardFetch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function ndjson(lines: object[]) {
    return new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), { status: 200 });
  }

  it("coalesces same-tick calls into one batch and hands each caller its own response", async () => {
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { i: 1, status: 403, body: { error: "Forbidden" } },
        { i: 0, status: 200, body: { data: { a: 1 } } },
      ])
    );

    const [a, b] = await Promise.all([
      dashboardFetch("/api/dashboard/occupancy?location_id=x"),
      dashboardFetch("/api/dashboard/cash-aging"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/dashboard/batch");
    expect(JSON.parse(init.body)).toEqual({
      requests: ["/api/dashboard/occupancy?location_id=x", "/api/dashboard/cash-aging"],
    });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ data: { a: 1 } });
    expect(b.ok).toBe(false);
    expect(b.status).toBe(403);
  });

  it("sends a lone call directly, without the batch endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await dashboardFetch("/api/dashboard/support");
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/support");
  });

  it("falls back to individual fetches for anything the batch didn't answer", async () => {
    fetchMock
      .mockResolvedValueOnce(ndjson([{ i: 0, status: 200, body: { ok: 1 } }]))
      .mockResolvedValue(new Response(JSON.stringify({ direct: true }), { status: 200 }));

    const [a, b] = await Promise.all([
      dashboardFetch("/api/dashboard/team"),
      dashboardFetch("/api/dashboard/renewals"),
    ]);

    expect(await a.json()).toEqual({ ok: 1 });
    expect(await b.json()).toEqual({ direct: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/dashboard/renewals");
  });

  it("falls back for every call when the batch request itself fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify({ direct: true }), { status: 200 }));

    const res = await Promise.all([
      dashboardFetch("/api/dashboard/team"),
      dashboardFetch("/api/dashboard/renewals"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await res[0].json()).toEqual({ direct: true });
  });
});
