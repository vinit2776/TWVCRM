import { describe, it, expect } from "vitest";
import { evaluateInvoiceTolerance, clampTolerancePercent } from "@/lib/procurement/price-tolerance";

const base = { base: 100000, tolerancePercent: 10, priorInvoiced: 0, fullyReceived: true };

describe("evaluateInvoiceTolerance", () => {
  it("does nothing on a firm PO", () => {
    expect(evaluateInvoiceTolerance({ ...base, tolerancePercent: 0, invoiceTotal: 150000 })).toEqual({ kind: "ok" });
  });
  it("accepts an exact or slightly lower invoice", () => {
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 100000 })).toEqual({ kind: "ok" });
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 95000 })).toEqual({ kind: "ok" });
  });
  it("treats an invoice above the PO but inside the allowance as within", () => {
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 109500 })).toEqual({ kind: "within", varianceAmount: 9500, variancePercent: 9.5 });
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 110000 }).kind).toBe("within");
  });
  it("flags an invoice beyond the allowance", () => {
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 114000 })).toEqual({ kind: "exception", direction: "above", varianceAmount: 14000, variancePercent: 14 });
  });
  it("counts earlier bills toward the allowance", () => {
    expect(evaluateInvoiceTolerance({ ...base, priorInvoiced: 60000, invoiceTotal: 48000 }).kind).toBe("within");
    expect(evaluateInvoiceTolerance({ ...base, priorInvoiced: 60000, invoiceTotal: 52000 }).kind).toBe("exception");
  });
  it("flags a single invoice far below a fully received PO", () => {
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 88000 })).toEqual({ kind: "exception", direction: "below", varianceAmount: -12000, variancePercent: -12 });
  });
  it("does not flag a partial invoice as under-billing", () => {
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 40000, fullyReceived: false }).kind).toBe("ok");
    expect(evaluateInvoiceTolerance({ ...base, invoiceTotal: 40000, priorInvoiced: 30000 }).kind).toBe("ok");
  });
});

describe("clampTolerancePercent", () => {
  it("keeps values in 0..10", () => {
    expect(clampTolerancePercent(25)).toBe(10);
    expect(clampTolerancePercent(-3)).toBe(0);
    expect(clampTolerancePercent("5")).toBe(5);
    expect(clampTolerancePercent(undefined)).toBe(0);
  });
});
