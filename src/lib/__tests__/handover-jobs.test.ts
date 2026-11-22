import { describe, it, expect } from "vitest";
import { canCompleteJob, canEditJob, defaultJobTitle } from "../handover-jobs";

const job = { kind: "send_proposal", assigned_to: "priya", handed_over_by: "vignesh" };
const plain = { kind: "general", assigned_to: "priya", handed_over_by: null };

describe("canCompleteJob", () => {
  it("lets only the person it was handed to finish a job, or an admin", () => {
    expect(canCompleteJob(job, "priya", "sales_rep")).toBe(true);
    expect(canCompleteJob(job, "vignesh", "sales_rep")).toBe(false);
    expect(canCompleteJob(job, "someone", "admin")).toBe(true);
    expect(canCompleteJob(job, null, null)).toBe(false);
  });
  it("leaves plain tasks as they were", () => {
    expect(canCompleteJob(plain, "vignesh", "sales_rep")).toBe(true);
  });
});

describe("canEditJob", () => {
  it("lets only the giver change a job, or an admin", () => {
    expect(canEditJob(job, "vignesh", "sales_rep")).toBe(true);
    expect(canEditJob(job, "priya", "sales_rep")).toBe(false);
    expect(canEditJob(job, "someone", "admin")).toBe(true);
  });
  it("leaves plain tasks as they were", () => {
    expect(canEditJob(plain, "anyone", "sales_rep")).toBe(true);
  });
});

describe("defaultJobTitle", () => {
  it("names the job after the customer", () => {
    expect(defaultJobTitle("send_proposal", "Ravi Shah")).toBe("Send a proposal to Ravi Shah");
    expect(defaultJobTitle("call_back", " ")).toBe("Call back the customer");
  });
});
