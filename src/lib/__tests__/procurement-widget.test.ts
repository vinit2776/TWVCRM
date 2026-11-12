import { describe, it, expect } from "vitest";
import { derivePoState, gradeBudget, normaliseDepartment, type PoBillShape } from "../procurement-widget";

const bill = (total: number, paid: number, approval = "approved"): PoBillShape => ({
  total_amount: total,
  amount_paid: paid,
  approval_status: approval,
});

describe("derivePoState — no bills, state follows the PO", () => {
  it.each([
    ["pending", "pending"],
    ["ordered", "ordered"],
    ["partially_received", "part_recv"],
    ["received", "recv"],
    ["invoice_received", "inv"],
    ["invoice_approved", "inv_ok"],
    ["partially_cancelled", "ordered"],
    ["cancelled", "cancelled"],
  ])("%s → %s", (status, expected) => {
    expect(derivePoState({ status }, [])).toBe(expected);
  });
});

describe("derivePoState — bills win once they exist", () => {
  it("is paid when everything billed is settled", () => {
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000, 1000)])).toBe("paid");
  });

  it("tolerates paise-level rounding on the final payment", () => {
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000.4, 1000)])).toBe("paid");
  });

  it("is part-paid once any money has gone out", () => {
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000, 400)])).toBe("part_paid");
  });

  it("is part-paid when one of two bills is paid and the other is not", () => {
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000, 1000), bill(500, 0)])).toBe("part_paid");
  });

  it("is invoice-approved when all bills are approved and nothing is paid", () => {
    expect(derivePoState({ status: "invoice_received" }, [bill(1000, 0), bill(500, 0)])).toBe("inv_ok");
  });

  it("stays at invoice-received while any bill is still unapproved", () => {
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000, 0), bill(500, 0, "pending")])).toBe("inv");
  });

  it("ignores rejected bills", () => {
    expect(derivePoState({ status: "received" }, [bill(1000, 0, "rejected")])).toBe("recv");
    expect(derivePoState({ status: "invoice_approved" }, [bill(1000, 1000), bill(900, 0, "rejected")])).toBe("paid");
  });

  it("a cancelled PO stays cancelled whatever its bills say", () => {
    expect(derivePoState({ status: "cancelled" }, [bill(1000, 1000)])).toBe("cancelled");
  });
});

describe("gradeBudget", () => {
  it("grades against 80% and 100%", () => {
    expect(gradeBudget(790, 1000)).toBe("ok");
    expect(gradeBudget(800, 1000)).toBe("warn");
    expect(gradeBudget(1000, 1000)).toBe("warn");
    expect(gradeBudget(1001, 1000)).toBe("over");
  });

  it("has no grade without a budget", () => {
    expect(gradeBudget(500, null)).toBe("none");
    expect(gradeBudget(500, 0)).toBe("none");
    expect(gradeBudget(500, undefined)).toBe("none");
  });
});

describe("normaliseDepartment", () => {
  it("keeps known departments and buckets the rest", () => {
    expect(normaliseDepartment("pantry")).toBe("pantry");
    expect(normaliseDepartment("amc")).toBe("amc");
    expect(normaliseDepartment(null)).toBe("other");
    expect(normaliseDepartment("something_new")).toBe("other");
  });
});
