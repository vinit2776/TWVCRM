import { describe, it, expect } from "vitest";
import { describeOnegridError } from "../onegrid-errors";

describe("describeOnegridError", () => {
  it("treats OneGrid's own registry timeout (the real production message) as temporary unavailability", () => {
    const raw =
      "Supabase registry unreachable: HTTPSConnectionPool(host='pwcztgbpnzqmmqkpvacm.supabase.co', port=443): Max retries exceeded with url: /rest/v1/devices (Caused by ConnectTimeoutError)";
    const e = describeOnegridError({ status: 503, message: raw });
    expect(e.kind).toBe("unavailable");
    expect(e.message).not.toContain("supabase.co");
    expect(e.message).toMatch(/not affected/);
    expect(e.detail).toBe(raw);
  });
  it("treats our own network failure code as unavailable", () => {
    expect(describeOnegridError({ status: 502, code: "NETWORK_ERROR", message: "Could not reach the OneGrid telemetry service" }).kind).toBe("unavailable");
  });
  it("recognises a timeout even without a 5xx status", () => {
    expect(describeOnegridError({ message: "Connection timed out" }).kind).toBe("unavailable");
  });
  it("maps rejected keys to a fix-it message", () => {
    expect(describeOnegridError({ status: 401, message: "bad key" }).kind).toBe("auth");
    expect(describeOnegridError({ code: "INVALID_API_KEY" }).kind).toBe("auth");
  });
  it("maps 404 to no data", () => {
    expect(describeOnegridError({ status: 404 }).kind).toBe("no_data");
  });
  it("falls back to the caller's wording and keeps the raw text", () => {
    const e = describeOnegridError({ status: 500, message: "Failed to fetch telemetry" }, "Failed to load history");
    expect(e).toEqual({ kind: "other", message: "Failed to load history", detail: "Failed to fetch telemetry" });
  });
  it("does not invent detail when there is none", () => {
    expect(describeOnegridError({ status: 500 }).detail).toBeNull();
  });
});
