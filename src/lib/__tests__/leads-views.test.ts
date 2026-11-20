import { describe, it, expect } from "vitest";
import { parseLeadsView, leadsViewHref, LEADS_VIEWS } from "../leads-views";

describe("parseLeadsView", () => {
  it("reads every known view", () => {
    for (const v of LEADS_VIEWS) expect(parseLeadsView(v)).toBe(v);
  });
  it("falls back to All leads for nothing or nonsense", () => {
    expect(parseLeadsView(null)).toBe("all");
    expect(parseLeadsView(undefined)).toBe("all");
    expect(parseLeadsView("")).toBe("all");
    expect(parseLeadsView("bogus")).toBe("all");
  });
});

describe("leadsViewHref", () => {
  it("keeps All leads on the bare page and puts the rest in ?view=", () => {
    expect(leadsViewHref("all")).toBe("/leads");
    expect(leadsViewHref("tours")).toBe("/leads?view=tours");
  });
  it("round-trips through parseLeadsView", () => {
    for (const v of LEADS_VIEWS) expect(parseLeadsView(new URL(leadsViewHref(v), "http://x").searchParams.get("view"))).toBe(v);
  });
});
