import { describe, it, expect } from "vitest";
import { afterFinishing, checkPanelHref, panelNeighbours } from "../enquiry-panel";

const ids = ["a", "b", "c"];

describe("panelNeighbours", () => {
  it("finds the one before and after, and the position", () => {
    expect(panelNeighbours(ids, "b")).toEqual({ prev: "a", next: "c", position: 2 });
  });
  it("has nothing before the first or after the last", () => {
    expect(panelNeighbours(ids, "a")).toEqual({ prev: null, next: "b", position: 1 });
    expect(panelNeighbours(ids, "c")).toEqual({ prev: "b", next: null, position: 3 });
  });
  it("copes with an enquiry that is not in the list", () => {
    expect(panelNeighbours(ids, "x")).toEqual({ prev: null, next: null, position: null });
  });
});

describe("afterFinishing", () => {
  it("moves on to the next, else the previous, else nothing", () => {
    expect(afterFinishing(ids, "a")).toBe("b");
    expect(afterFinishing(ids, "c")).toBe("b");
    expect(afterFinishing(["a"], "a")).toBeNull();
    expect(afterFinishing(ids, "x")).toBeNull();
  });
});

describe("checkPanelHref", () => {
  it("keeps the current Leads view under the panel", () => {
    expect(checkPanelHref("e1", "/leads", "?view=tours")).toBe("/leads?view=tours&enquiry=e1");
    expect(checkPanelHref("e1", "/leads", "")).toBe("/leads?enquiry=e1");
  });
  it("replaces an earlier enquiry rather than stacking two", () => {
    expect(checkPanelHref("e2", "/leads", "?view=enquiries&enquiry=e1")).toBe("/leads?view=enquiries&enquiry=e2");
  });
  it("opens over New enquiries from any other page", () => {
    expect(checkPanelHref("e1", "/dashboard", "?x=1")).toBe("/leads?view=enquiries&enquiry=e1");
  });
});
