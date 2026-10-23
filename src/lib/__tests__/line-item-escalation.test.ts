import { describe, it, expect } from "vitest";
import { escalateUnitPrice, lineEscalates } from "../line-item-escalation";

const rupee = (n: number) => Math.round(n);

describe("line item escalation", () => {
  it("escalates lines with no flag (legacy single-line contracts)", () => {
    expect(lineEscalates({})).toBe(true);
    expect(escalateUnitPrice({ unit_price: 234240 }, 1.07, rupee)).toBe(250637);
  });

  it("leaves a fixed (escalates: false) line unchanged", () => {
    expect(escalateUnitPrice({ unit_price: 28800, escalates: false }, 1.07, rupee)).toBe(28800);
  });

  it("TWV-C-0100 renewal: 7% on rent only gives 248,620.80 a month", () => {
    const rent = escalateUnitPrice({ unit_price: 205440, escalates: true }, 1.07);
    const maint = escalateUnitPrice({ unit_price: 28800, escalates: false }, 1.07);
    expect(Math.round((rent + maint) * 100) / 100).toBe(248620.8);
  });
});
