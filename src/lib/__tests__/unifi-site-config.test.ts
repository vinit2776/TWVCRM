import { describe, it, expect, vi, beforeEach } from "vitest";

// What the mocked `locations` table returns for the next lookup.
let locationRow: Record<string, unknown> | null = null;
const fetchSpy = vi.fn();

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock("@/lib/crypto-secrets", () => ({ decryptSecret: (s: string) => s }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: locationRow, error: null }) }),
      }),
    }),
  }),
}));

import {
  UnifiConfigError,
  siteConfigFromLocation,
  siteConfigForLocationId,
  siteConfigForStoredVoucher,
  unifiRequest,
  cachedUnifiRequest,
  buildVoucherNote,
  stripVoucherNotePrefix,
  type SiteConfig,
} from "../unifi";

const PGD = "6C63F88F86E3000000000929B7A30000000009A796AD0000000068417BA0:376375377";
const NGM = "60223211830500000000068A48C60000000006D8E9030000000062D3FFFC:1779918393";

beforeEach(() => {
  locationRow = null;
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  // A UNIFI_CONSOLE_ID in the environment must make no difference any more.
  process.env.UNIFI_CONSOLE_ID = NGM;
});

describe("siteConfigFromLocation", () => {
  it("uses the location's own console and site", () => {
    expect(siteConfigFromLocation({ unifi_console_id: PGD, unifi_site_id: "perungudi" })).toEqual({
      consoleId: PGD,
      siteName: "perungudi",
    });
  });

  it("defaults only the site name (UniFi's built-in 'default'), never the console", () => {
    expect(siteConfigFromLocation({ unifi_console_id: PGD })).toEqual({ consoleId: PGD, siteName: "default" });
  });

  it.each([null, undefined, "", "   "])("throws for a missing console id (%j) even when UNIFI_CONSOLE_ID is set", (id) => {
    expect(() => siteConfigFromLocation({ unifi_console_id: id, unifi_site_id: "default", code: "PGD" })).toThrow(UnifiConfigError);
  });

  it("names the location in the error", () => {
    expect(() => siteConfigFromLocation({ code: "PGD" })).toThrow(/PGD/);
  });
});

describe("siteConfigForLocationId", () => {
  it("throws for a missing location id instead of defaulting", async () => {
    await expect(siteConfigForLocationId(null)).rejects.toBeInstanceOf(UnifiConfigError);
    await expect(siteConfigForLocationId(undefined)).rejects.toBeInstanceOf(UnifiConfigError);
  });

  it("throws for an unknown location", async () => {
    locationRow = null;
    await expect(siteConfigForLocationId("loc-1")).rejects.toBeInstanceOf(UnifiConfigError);
  });

  it("throws for a location with no console id", async () => {
    locationRow = { code: "PGD", unifi_console_id: null, unifi_site_id: "default" };
    await expect(siteConfigForLocationId("loc-1")).rejects.toBeInstanceOf(UnifiConfigError);
  });

  it("resolves a location that has one", async () => {
    locationRow = { code: "PGD", unifi_console_id: PGD, unifi_site_id: "default" };
    await expect(siteConfigForLocationId("loc-1")).resolves.toEqual({ consoleId: PGD, siteName: "default" });
  });
});

describe("siteConfigForStoredVoucher", () => {
  it("uses the console recorded at issue time, not the location's current one", async () => {
    locationRow = { unifi_console_id: PGD, unifi_site_id: "perungudi" };
    const cfg = await siteConfigForStoredVoucher({ consoleId: NGM, locationId: "loc-1" });
    expect(cfg.consoleId).toBe(NGM);
    // The location now points elsewhere, so its site name must not be borrowed.
    expect(cfg.siteName).toBe("default");
  });

  it("borrows the location's site name while it still points at the same console", async () => {
    locationRow = { unifi_console_id: PGD, unifi_site_id: "perungudi" };
    await expect(siteConfigForStoredVoucher({ consoleId: PGD, locationId: "loc-1" })).resolves.toEqual({
      consoleId: PGD,
      siteName: "perungudi",
    });
  });

  it("falls back to the location only for rows that predate the record", async () => {
    locationRow = { code: "PGD", unifi_console_id: PGD, unifi_site_id: "default" };
    await expect(siteConfigForStoredVoucher({ consoleId: null, locationId: "loc-1" })).resolves.toMatchObject({ consoleId: PGD });
  });

  it("still fails loudly when there is neither a stored console nor a usable location", async () => {
    await expect(siteConfigForStoredVoucher({ consoleId: null, locationId: null })).rejects.toBeInstanceOf(UnifiConfigError);
  });
});

describe("no silent default console", () => {
  it("unifiRequest without a config throws before any network call", async () => {
    await expect(unifiRequest("/stat/voucher", {}, undefined as unknown as SiteConfig)).rejects.toBeInstanceOf(UnifiConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unifiRequest with a blank console throws before any network call", async () => {
    await expect(unifiRequest("/stat/voucher", {}, { consoleId: "  ", siteName: "default" })).rejects.toBeInstanceOf(UnifiConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cachedUnifiRequest without a config throws too", () => {
    expect(() => cachedUnifiRequest("/stat/voucher", {}, 60, undefined as unknown as SiteConfig)).toThrow(UnifiConfigError);
  });
});

describe("voucher note", () => {
  it("leads with the location code", () => {
    expect(buildVoucherNote("PGD", "TWV-C-0123_seat1")).toBe("PGD | TWV-C-0123_seat1");
  });

  it("leaves the note alone when there is no code", () => {
    expect(buildVoucherNote(null, "TWV-C-0123_seat1")).toBe("TWV-C-0123_seat1");
    expect(buildVoucherNote("  ", "x")).toBe("x");
  });

  it("round-trips, including codes with spaces or dashes", () => {
    for (const code of ["PGD", "MWP-HQ", "HT MEDIA"]) {
      expect(stripVoucherNotePrefix(buildVoucherNote(code, "booking_abc_seat2"))).toBe("booking_abc_seat2");
    }
  });

  it("does not touch notes without a prefix", () => {
    expect(stripVoucherNotePrefix("TWV-C-0123_seat1")).toBe("TWV-C-0123_seat1");
    expect(stripVoucherNotePrefix("BDart_Rajesh")).toBe("BDart_Rajesh");
  });
});
