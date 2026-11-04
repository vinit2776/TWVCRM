import { describe, it, expect } from "vitest";
import { decideAttachment, type LiveContract } from "../adhoc-contract-attach";

const c = (id: string): LiveContract => ({ id, contract_number: `TWV-C-${id}`, status: "active", end_date: "2099-01-01" });

describe("decideAttachment", () => {
  it("leaves the invoice on the ad-hoc page when no contract is live", () => {
    expect(decideAttachment([])).toEqual({ kind: "none" });
  });
  it("attaches by itself to the only live contract", () => {
    expect(decideAttachment([c("1")])).toEqual({ kind: "attach", contractId: "1" });
  });
  it("makes the person choose when several are live", () => {
    expect(decideAttachment([c("1"), c("2")])).toEqual({ kind: "choose" });
  });
  it("accepts a chosen live contract", () => {
    expect(decideAttachment([c("1"), c("2")], "2")).toEqual({ kind: "attach", contractId: "2" });
  });
  it("rejects a contract that is not the customer's", () => {
    expect(decideAttachment([c("1")], "9")).toEqual({ kind: "invalid" });
    expect(decideAttachment([], "9")).toEqual({ kind: "invalid" });
  });
  it("accepts the customer's own not-yet-live contract when asked for by id", () => {
    expect(decideAttachment([c("1"), c("2")], "9", true)).toEqual({ kind: "attach", contractId: "9" });
  });
});
