import { describe, expect, it } from "vitest";
import { accountsNoteFor } from "../tally-handoff";

const row = (statement_notes: string | null, invoiceNote: string | null = null) =>
  ({ statement_notes, invoice: invoiceNote ? { internal_notes: invoiceNote } : null }) as Parameters<typeof accountsNoteFor>[0];

describe("accountsNoteFor", () => {
  it("returns the requester's note", () => {
    expect(accountsNoteFor(row("  Raise against Clix, PO pending  "))).toBe("Raise against Clix, PO pending");
  });
  it("ignores empty notes and the auto-filled default", () => {
    expect(accountsNoteFor(row(null))).toBeNull();
    expect(accountsNoteFor(row("   "))).toBeNull();
    expect(accountsNoteFor(row("Reimbursement billing for PR-2611-030"))).toBeNull();
  });
  it("does not repeat the ad-hoc invoice's own internal note", () => {
    expect(accountsNoteFor(row("Hold till PO", "Hold till PO"))).toBeNull();
  });
});
