import { describe, it, expect, vi, beforeEach } from "vitest";

const revoke = vi.fn();
const resolve = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/cosec", () => ({ setUserActive: vi.fn() }));
vi.mock("@/lib/unifi", () => ({
  revokeUnifiVoucher: (...a: unknown[]) => revoke(...a),
  siteConfigForStoredVoucher: (...a: unknown[]) => resolve(...a),
}));

import { revokeUnifiIssuances } from "../contract-lifecycle";

beforeEach(() => {
  revoke.mockReset().mockResolvedValue(undefined);
  resolve.mockReset().mockImplementation(async ({ consoleId }: { consoleId?: string }) => ({ consoleId: consoleId ?? "from-location", siteName: "default" }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("revokeUnifiIssuances", () => {
  it("revokes each per-seat voucher on the console that issued it", async () => {
    const n = await revokeUnifiIssuances(
      [
        { unifi_voucher_id: "v1", unifi_console_id: "console-A" },
        { unifi_voucher_id: "v2", unifi_console_id: "console-B" },
      ],
      "loc-1",
      "TWV-C-1"
    );
    expect(n).toBe(2);
    expect(revoke).toHaveBeenCalledWith("v1", { consoleId: "console-A", siteName: "default" });
    expect(revoke).toHaveBeenCalledWith("v2", { consoleId: "console-B", siteName: "default" });
  });

  it("skips import-based issuances (no UniFi voucher)", async () => {
    const n = await revokeUnifiIssuances([{ unifi_voucher_id: null }, {}], "loc-1", "TWV-C-1");
    expect(n).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("falls back to the location only for rows without a recorded console", async () => {
    await revokeUnifiIssuances([{ unifi_voucher_id: "v1", unifi_console_id: null }], "loc-1", "TWV-C-1");
    expect(resolve).toHaveBeenCalledWith({ consoleId: null, locationId: "loc-1" });
  });

  it("one failure does not stop the others or throw", async () => {
    resolve.mockRejectedValueOnce(new Error("no console"));
    const n = await revokeUnifiIssuances(
      [{ unifi_voucher_id: "bad" }, { unifi_voucher_id: "good", unifi_console_id: "console-A" }],
      "loc-1",
      "TWV-C-1"
    );
    expect(n).toBe(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("good", expect.anything());
    expect(console.error).toHaveBeenCalled();
  });
});
