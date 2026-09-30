import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { istTodayYmd, gstInvoiceFyPrefix, allocateGstInvoiceNumber } from "../gst-invoice-number";

describe("istTodayYmd", () => {
  it("dates an early-morning IST issue on the IST day, not the previous UTC day", () => {
    // 00:30 IST on 1 Oct = 19:00 UTC on 30 Sep
    expect(istTodayYmd(new Date("2026-09-30T19:00:00Z"))).toBe("2026-10-01");
  });

  it("matches the UTC date once IST and UTC agree", () => {
    expect(istTodayYmd(new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01");
  });
});

describe("gstInvoiceFyPrefix", () => {
  it("starts the new FY at 00:00 IST on 1 April", () => {
    // 00:10 IST on 1 Apr 2027 = 18:40 UTC on 31 Mar 2027
    expect(gstInvoiceFyPrefix(new Date("2027-03-31T18:40:00Z"))).toBe("TWV/INV/27-28/");
  });

  it("keeps late 31 March IST in the old FY", () => {
    expect(gstInvoiceFyPrefix(new Date("2027-03-31T18:00:00Z"))).toBe("TWV/INV/26-27/");
  });

  it("uses the calendar year as FY start from April", () => {
    expect(gstInvoiceFyPrefix(new Date("2026-09-30T06:00:00Z"))).toBe("TWV/INV/26-27/");
    expect(gstInvoiceFyPrefix(new Date("2027-01-15T06:00:00Z"))).toBe("TWV/INV/26-27/");
  });
});

describe("allocateGstInvoiceNumber", () => {
  function clientReturning(result: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("asks the RPC for the IST FY prefix and returns its number", async () => {
    const { client, rpc } = clientReturning({ data: "TWV/INV/27-28/0001", error: null });
    const n = await allocateGstInvoiceNumber(client, new Date("2027-03-31T18:40:00Z"));
    expect(rpc).toHaveBeenCalledWith("next_gst_invoice_number", { p_fy_prefix: "TWV/INV/27-28/" });
    expect(n).toBe("TWV/INV/27-28/0001");
  });

  it("throws rather than issuing an invoice without a number", async () => {
    const { client } = clientReturning({ data: null, error: { message: "boom" } });
    await expect(allocateGstInvoiceNumber(client)).rejects.toThrow(/boom/);
  });
});
