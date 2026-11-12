import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrRecoverGstLink,
  gstLinkReferenceId,
  isDuplicateReferenceId,
  pickReusableLink,
} from "@/lib/razorpay-gst-link";

const DUPLICATE_BODY = JSON.stringify({
  error: {
    code: "BAD_REQUEST_ERROR",
    description:
      "payment link with given reference_id: SD-A-26-27-408-gst already exists. Please create a payment link with a different reference_id",
  },
});

const link = (over: Record<string, unknown> = {}) => ({
  id: "plink_1",
  short_url: "https://rzp.io/i/abc",
  status: "created",
  amount: 2674800,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("gstLinkReferenceId", () => {
  it("turns the invoice number into a Razorpay-safe reference", () => {
    expect(gstLinkReferenceId("SD/A/26-27/408")).toBe("SD-A-26-27-408-gst");
  });
});

describe("isDuplicateReferenceId", () => {
  it("recognises the real Razorpay rejection", () => {
    expect(isDuplicateReferenceId(400, DUPLICATE_BODY)).toBe(true);
  });

  it("does not treat other failures as a duplicate", () => {
    expect(isDuplicateReferenceId(400, '{"error":{"description":"amount is invalid"}}')).toBe(false);
    expect(isDuplicateReferenceId(500, DUPLICATE_BODY)).toBe(false);
  });
});

describe("pickReusableLink", () => {
  it("returns a payable link with the same amount", () => {
    expect(pickReusableLink({ payment_links: [link()] }, 2674800)).toEqual({
      id: "plink_1",
      url: "https://rzp.io/i/abc",
    });
  });

  it("skips paid, cancelled and expired links", () => {
    for (const status of ["paid", "cancelled", "expired"]) {
      expect(pickReusableLink({ payment_links: [link({ status })] }, 2674800)).toBeNull();
    }
  });

  it("never reuses a link raised for a different amount", () => {
    expect(pickReusableLink({ payment_links: [link({ amount: 100 })] }, 2674800)).toBeNull();
  });

  it("returns null for any unexpected shape", () => {
    expect(pickReusableLink(null, 1)).toBeNull();
    expect(pickReusableLink({}, 1)).toBeNull();
    expect(pickReusableLink({ payment_links: "x" }, 1)).toBeNull();
    expect(pickReusableLink({ payment_links: [{ id: 1, short_url: 2 }] }, 1)).toBeNull();
  });
});

describe("createOrRecoverGstLink", () => {
  const payload = { reference_id: "SD-A-26-27-408-gst", amount: 2674800 };
  const call = () => createOrRecoverGstLink({ rzpAuth: "x", payload, logTag: "test" });

  it("returns the new link when Razorpay creates it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "plink_new", short_url: "https://rzp.io/i/new" }),
    }));
    expect(await call()).toEqual({ id: "plink_new", url: "https://rzp.io/i/new" });
  });

  it("recovers the existing link when the reference_id is already taken", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => DUPLICATE_BODY })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payment_links: [link()] }) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await call()).toEqual({ id: "plink_1", url: "https://rzp.io/i/abc" });
    expect(fetchMock.mock.calls[1][0]).toContain("reference_id=SD-A-26-27-408-gst");
  });

  it("returns null — so callers keep the stored link — when the duplicate is not payable", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => DUPLICATE_BODY })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payment_links: [link({ status: "expired" })] }) }));
    expect(await call()).toBeNull();
  });

  it("returns null without a lookup for any other Razorpay failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"description":"amount is invalid"}}',
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await call()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
