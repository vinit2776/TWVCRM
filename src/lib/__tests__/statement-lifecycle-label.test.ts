import { describe, it, expect } from "vitest";
import { badgeLabel, statusFallbackLabel } from "@/components/accounting/statement-lifecycle";

// A finalized GST Direct statement that hasn't been handed to the Tally Inbox
// has no handoff row — it used to fall through to "Draft" on the contract page.
describe("statement lifecycle badge label", () => {
  it("labels a finalized statement with no handoff row as Finalized, not Draft", () => {
    expect(badgeLabel(null, "finalized")).toBe("Finalized");
    expect(statusFallbackLabel("finalized")).toBe("Finalized");
  });

  it("still labels a genuine draft as Draft", () => {
    expect(badgeLabel(null, "draft")).toBe("Draft");
    expect(badgeLabel(null, undefined)).toBe("Draft");
  });

  it("maps exported and voided", () => {
    expect(statusFallbackLabel("exported")).toBe("Exported");
    expect(statusFallbackLabel("voided")).toBe("Voided");
  });
});
