import { describe, it, expect } from "vitest";
import { holdReason, isTaskUnissued, planGstTasks, paymentStatusForTotal, postCheckoutExtrasAllowed, type TaskLike } from "../booking-extras";

const task = (over: Partial<TaskLike> = {}): TaskLike => ({
  kind: "main", sequence: 1, amount_with_gst: 1180, handoff_state: "gst_to_issue",
  gst_invoice_number: null, tally_invoice_number: null, voided_at: null, ...over,
});
const issued = (over: Partial<TaskLike> = {}) => task({ handoff_state: "complete", gst_invoice_number: "SD/B/1", ...over });

describe("postCheckoutExtrasAllowed", () => {
  it("is for checked-out walk-in and guest bookings only", () => {
    expect(postCheckoutExtrasAllowed({ status: "checked_out", customer_type: "walk_in", contract_id: null })).toBe(true);
    expect(postCheckoutExtrasAllowed({ status: "checked_out", customer_type: "guest", contract_id: null })).toBe(true);
    expect(postCheckoutExtrasAllowed({ status: "checked_in", customer_type: "walk_in", contract_id: null })).toBe(false);
    expect(postCheckoutExtrasAllowed({ status: "checked_out", customer_type: "contract_holder", contract_id: "c1" })).toBe(false);
  });
});

describe("paymentStatusForTotal", () => {
  it("reopens the balance when an extra lifts the total past what was paid", () => {
    expect(paymentStatusForTotal(1770, 1180)).toBe("pending");
    expect(paymentStatusForTotal(1180, 1180)).toBe("paid");
  });
});

describe("planGstTasks", () => {
  it("creates the main task for the whole total", () => {
    expect(planGstTasks(1180, [])).toEqual({ action: "create_main", amount: 1180 });
  });

  it("folds an extra into an unissued main task, so accounts raise one invoice", () => {
    expect(planGstTasks(1770, [task()])).toEqual({ action: "refresh", taskIndex: 0, amount: 1770 });
  });

  it("raises a supplement for the extra once the main invoice is issued", () => {
    expect(planGstTasks(1770, [issued()])).toEqual({ action: "create_supplement", sequence: 2, amount: 590 });
  });

  it("does nothing when everything issued already covers the total", () => {
    expect(planGstTasks(1180, [issued()])).toEqual({ action: "none" });
  });

  it("folds a second extra into an unissued supplement rather than making a third", () => {
    const tasks = [issued(), task({ kind: "supplement", sequence: 2, amount_with_gst: 590 })];
    expect(planGstTasks(2360, tasks)).toEqual({ action: "refresh", taskIndex: 1, amount: 1180 });
  });

  it("respects a main task accounts voided", () => {
    expect(planGstTasks(1770, [task({ voided_at: "2026-11-13T10:00:00Z" })])).toEqual({ action: "none" });
  });
});

describe("isTaskUnissued / holdReason", () => {
  it("is unissued only before the GST invoice is started", () => {
    expect(isTaskUnissued(task())).toBe(true);
    expect(isTaskUnissued(issued())).toBe(false);
  });

  it("holds an unissued task while the booking has an unpaid extra", () => {
    expect(holdReason({ unissued: true, bookingPaymentStatus: "pending", balance: 590 })).toBe("Waiting for ₹590 extra to be paid");
    expect(holdReason({ unissued: true, bookingPaymentStatus: "paid", balance: 0 })).toBeNull();
    expect(holdReason({ unissued: false, bookingPaymentStatus: "pending", balance: 590 })).toBeNull();
  });
});
