import { describe, it, expect } from "vitest";
import { findGuide } from "@/lib/flow-guides";

describe("flow guide for the Renewals desk", () => {
  it("is found for the desk, not swallowed by the case-detail pattern", () => {
    expect(findGuide("/cases/renewals")?.key).toBe("cases-renewals");
  });

  it("still gives a case page its own guide", () => {
    expect(findGuide("/cases/3f2c9a10-1111-2222-3333-444455556666")?.key).toBe("cases-detail");
  });
});
