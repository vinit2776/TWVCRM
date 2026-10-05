import { describe, it, expect } from "vitest";
import { classifyCurrentCycleStatement, rentGapReason } from "../unbilled-queue";

const base = {
  status: "finalized",
  proforma_sent_at: null,
  gst_invoice_sent_at: null,
  gst_invoice_number: null,
  handoff_state: null,
  finalized_at: "2026-09-30T13:00:00Z",
};

describe("classifyCurrentCycleStatement", () => {
  it("a sent proforma is 'sent', stamped with when it went out", () => {
    expect(classifyCurrentCycleStatement({ ...base, proforma_sent_at: "2026-09-29T13:12:00Z" }))
      .toEqual({ group: "sent", at: "2026-09-29T13:12:00Z", detail: "Proforma sent" });
  });

  it("a sent GST invoice is 'sent'", () => {
    expect(classifyCurrentCycleStatement({ ...base, gst_invoice_sent_at: "2026-10-02T05:35:00Z" })?.group).toBe("sent");
  });

  it("an issued-but-unsent GST invoice is not offered for sending again", () => {
    expect(classifyCurrentCycleStatement({ ...base, gst_invoice_number: "TWV/26-27/0412" })?.group).toBe("sent");
  });

  it("GST Direct with accounts is 'tally', dated by its hand-off (finalized_at)", () => {
    expect(classifyCurrentCycleStatement({ ...base, handoff_state: "direct_gst_requested" }))
      .toEqual({ group: "tally", at: "2026-09-30T13:00:00Z", detail: "GST Direct · with accounts" });
  });

  it("draft and finalized-unsent are 'ready'", () => {
    expect(classifyCurrentCycleStatement({ ...base, status: "draft", finalized_at: null })?.group).toBe("ready");
    expect(classifyCurrentCycleStatement(base)?.group).toBe("ready");
  });

  it("a sent stamp wins over a lingering hand-off state", () => {
    expect(classifyCurrentCycleStatement({ ...base, handoff_state: "ready_to_send", gst_invoice_sent_at: "2026-10-03T06:00:00Z" })?.group)
      .toBe("sent");
  });

  it("exported without any send isn't listed", () => {
    expect(classifyCurrentCycleStatement({ ...base, status: "exported" })).toBeNull();
  });
});

describe("rentGapReason", () => {
  const r = (o: Partial<Parameters<typeof rentGapReason>[0]>) =>
    rentGapReason({ backfillable: false, beforeCrmBilling: false, status: "active", billingCycle: "monthly", isCurrentMonth: false, ...o });

  it("billable rows say why they're open", () => {
    expect(r({ backfillable: true, isCurrentMonth: true })).toBe("Missed month-end run");
    expect(r({ backfillable: true })).toBe("No rent invoice raised");
  });

  it("explains rows that can't be sent", () => {
    expect(r({ beforeCrmBilling: true })).toBe("Before CRM billing — waive if billed outside");
    expect(r({ status: "terminated" })).toBe("Contract terminated");
    expect(r({ status: "expired" })).toBe("Contract expired");
    expect(r({ billingCycle: "quarterly" })).toBe("Advance-billed contract — check its cycle on the contract page");
  });

  it("before-CRM wins over terminated", () => {
    expect(r({ beforeCrmBilling: true, status: "terminated" })).toBe("Before CRM billing — waive if billed outside");
  });
});
