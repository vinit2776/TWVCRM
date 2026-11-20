import { describe, it, expect } from "vitest";
import { canAddToEntry, canAddToRequest, canRemoveAttachment, needsReceiptNudge, safeFileName } from "../petty-cash-attachments";

const entry = (status: string) => ({ submitted_by: "u1", status });

describe("canAddToEntry", () => {
  it("lets the submitter add while pending or rejected", () => {
    for (const s of ["pending_manager", "pending_admin", "rejected"]) expect(canAddToEntry("manager", "u1", entry(s))).toBe(true);
  });
  it("stops the submitter once approved, but not accounts/admin", () => {
    expect(canAddToEntry("manager", "u1", entry("approved"))).toBe(false);
    expect(canAddToEntry("accounts", "u2", entry("approved"))).toBe(true);
    expect(canAddToEntry("admin", "u2", entry("approved"))).toBe(true);
  });
  it("refuses a withdrawn expense for everyone", () => {
    const w = { submitted_by: "u1", status: "rejected", withdrawn_at: "2026-11-20T10:00:00Z" };
    expect(canAddToEntry("manager", "u1", w)).toBe(false);
    expect(canAddToEntry("accounts", "u2", w)).toBe(false);
  });
  it("refuses someone else's expense", () => {
    expect(canAddToEntry("manager", "u2", entry("pending_manager"))).toBe(false);
  });
});

describe("canAddToRequest", () => {
  it("is accounts/admin only", () => {
    expect(canAddToRequest("accounts")).toBe(true);
    expect(canAddToRequest("admin")).toBe(true);
    expect(canAddToRequest("manager")).toBe(false);
  });
});

describe("canRemoveAttachment", () => {
  it("uploader can remove only while the record is open", () => {
    expect(canRemoveAttachment("manager", "u1", { uploaded_by: "u1" }, false)).toBe(true);
    expect(canRemoveAttachment("manager", "u1", { uploaded_by: "u1" }, true)).toBe(false);
    expect(canRemoveAttachment("manager", "u2", { uploaded_by: "u1" }, false)).toBe(false);
  });
  it("accounts/admin can always remove", () => {
    expect(canRemoveAttachment("accounts", "u9", { uploaded_by: "u1" }, true)).toBe(true);
  });
});

describe("needsReceiptNudge", () => {
  it("flags at or above the threshold with no file", () => {
    expect(needsReceiptNudge(1000, 0, 1000)).toBe(true);
    expect(needsReceiptNudge(999, 0, 1000)).toBe(false);
  });
  it("clears once a file is attached", () => {
    expect(needsReceiptNudge(5000, 1, 1000)).toBe(false);
  });
});

describe("safeFileName", () => {
  it("strips path tricks and keeps a readable name", () => {
    expect(safeFileName("../../Bill #1 (final).jpg")).toBe("....Bill-1-final.jpg");
    expect(safeFileName("///")).toBe("file");
  });
});
