import { describe, it, expect } from "vitest";
import { normalizePagePath } from "../page-path";

describe("normalizePagePath", () => {
  it("replaces a UUID segment with :id", () => {
    expect(normalizePagePath("/procurement/bills/4f1eab30-9c2e-4b7a-8a1e-2b6f0c9d1a2b")).toBe(
      "/procurement/bills/:id"
    );
  });

  it("replaces a numeric segment with :id", () => {
    expect(normalizePagePath("/proposals/482")).toBe("/proposals/:id");
  });

  it("leaves a plain route unchanged", () => {
    expect(normalizePagePath("/procurement/amc")).toBe("/procurement/amc");
  });

  it("strips a query string", () => {
    expect(normalizePagePath("/billing?statement=abc123")).toBe("/billing");
  });

  it("normalizes an empty path to /", () => {
    expect(normalizePagePath("")).toBe("/");
  });

  it("handles multiple id segments in one path", () => {
    expect(normalizePagePath("/contracts/482/renewals/501")).toBe("/contracts/:id/renewals/:id");
  });
});
