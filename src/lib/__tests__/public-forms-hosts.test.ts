import { describe, it, expect } from "vitest";
import { parseFormHosts, hostForPath, isAllowedOnFormHost } from "../public-forms/hosts";

const RAW = "enquire.theworkvilla.com=/enquire, Meta.theworkvilla.com=/meta,walkin.theworkvilla.com=/walkin";

describe("parseFormHosts", () => {
  it("parses, trims and lower-cases hosts", () => {
    const m = parseFormHosts(RAW);
    expect(m.get("meta.theworkvilla.com")).toBe("/meta");
    expect(m.size).toBe(3);
  });
  it("ignores junk and paths that are not a form", () => {
    expect(parseFormHosts("a.com=/dashboard,b.com,=/meta,c.com=/walkin").size).toBe(1);
  });
  it("is empty when unset", () => {
    expect(parseFormHosts(undefined).size).toBe(0);
    expect(parseFormHosts("").size).toBe(0);
  });
});

describe("hostForPath", () => {
  const m = parseFormHosts(RAW);
  it("finds the host serving a form path", () => {
    expect(hostForPath(m, "/meta")).toBe("meta.theworkvilla.com");
    expect(hostForPath(m, "/walkin/")).toBe("walkin.theworkvilla.com");
  });
  it("returns undefined for non-form paths", () => {
    expect(hostForPath(m, "/dashboard")).toBeUndefined();
    expect(hostForPath(m, "/metadata")).toBeUndefined();
  });
});

describe("isAllowedOnFormHost", () => {
  it("allows the forms, their APIs and assets", () => {
    for (const p of ["/meta", "/api/public/enquiry", "/api/public/locations", "/_next/static/x.js", "/logo-white.png", "/x/y.svg"])
      expect(isAllowedOnFormHost(p)).toBe(true);
  });
  it("blocks the CRM", () => {
    for (const p of ["/login", "/dashboard", "/api/me", "/api/leads"]) expect(isAllowedOnFormHost(p)).toBe(false);
  });
});
