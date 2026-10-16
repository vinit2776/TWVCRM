import { describe, it, expect } from "vitest";
import { poStatusAfterCancelRestore, poStatusAfterUnmarkReceived } from "../procurement/po-rollback";

const full = [{ quantity_ordered: 10, quantity_received: 10 }];
const part = [{ quantity_ordered: 10, quantity_received: 4 }];
const none = [{ quantity_ordered: 10, quantity_received: 0 }];

describe("poStatusAfterCancelRestore", () => {
  it("uses the status stored at cancel time", () => {
    expect(poStatusAfterCancelRestore("ordered", none)).toBe("ordered");
    expect(poStatusAfterCancelRestore("received", part)).toBe("received");
  });

  it("derives for POs cancelled before the status was recorded", () => {
    expect(poStatusAfterCancelRestore(null, full)).toBe("received");
    expect(poStatusAfterCancelRestore(null, part)).toBe("partially_received");
  });

  it("falls back to pending when nothing was received", () => {
    expect(poStatusAfterCancelRestore(null, none)).toBe("pending");
    expect(poStatusAfterCancelRestore(null, [])).toBe("pending");
  });

  it("ignores a stored status that is not a restorable one", () => {
    expect(poStatusAfterCancelRestore("invoice_received", none)).toBe("pending");
    expect(poStatusAfterCancelRestore("cancelled", part)).toBe("partially_received");
  });
});

describe("poStatusAfterUnmarkReceived", () => {
  it("refuses when the receipts really do cover the order", () => {
    expect(poStatusAfterUnmarkReceived(full)).toBeNull();
  });

  it("falls back to what the receipts support", () => {
    expect(poStatusAfterUnmarkReceived(part)).toBe("partially_received");
    expect(poStatusAfterUnmarkReceived(none)).toBe("ordered");
    expect(poStatusAfterUnmarkReceived([])).toBe("ordered");
  });
});
