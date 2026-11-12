import { describe, it, expect } from "vitest";
import { buildWorkOrderDescription, buildWorkOrderTitle, effectiveComplaintStatus, isOpenComplaint, suggestComplaintPriority } from "../complaints";

describe("suggestComplaintPriority", () => {
  it("is medium for a first complaint and high from the third", () => {
    expect(suggestComplaintPriority(0)).toBe("medium");
    expect(suggestComplaintPriority(1)).toBe("medium");
    expect(suggestComplaintPriority(2)).toBe("high");
  });
  it("lets safety wording raise it but never lower it", () => {
    expect(suggestComplaintPriority(0, "critical")).toBe("critical");
    expect(suggestComplaintPriority(3, "low")).toBe("high");
  });
});

describe("effectiveComplaintStatus", () => {
  it("a qualified complaint closes when its work order is resolved or closed", () => {
    expect(effectiveComplaintStatus("qualified", "in_progress")).toBe("qualified");
    expect(effectiveComplaintStatus("qualified", "resolved")).toBe("closed");
    expect(effectiveComplaintStatus("qualified", "closed")).toBe("closed");
  });
  it("a request closes when its task is done", () => {
    expect(effectiveComplaintStatus("qualified", null, "todo")).toBe("qualified");
    expect(effectiveComplaintStatus("qualified", null, "in_progress")).toBe("qualified");
    expect(effectiveComplaintStatus("qualified", null, "done")).toBe("closed");
  });
  it("other statuses are unaffected by an issue", () => {
    expect(effectiveComplaintStatus("new", "resolved")).toBe("new");
    expect(effectiveComplaintStatus("needs_info", null)).toBe("needs_info");
  });
  it("knows which statuses are open", () => {
    expect(["new", "needs_info", "qualified"].every((s) => isOpenComplaint(s as never))).toBe(true);
    expect(isOpenComplaint("closed")).toBe(false);
    expect(isOpenComplaint("not_a_complaint")).toBe(false);
  });
});

describe("work order text", () => {
  it("clips a long title and keeps the customer's own words in the description", () => {
    expect(buildWorkOrderTitle("AC not working in cabin 4")).toBe("Customer complaint: AC not working in cabin 4");
    expect(buildWorkOrderTitle("x".repeat(200)).length).toBeLessThan(100);
    const d = buildWorkOrderDescription({
      reference: "CMP-0007", customerName: "Rahul S.", contractNumber: "TWV-C-0150",
      messages: [{ text: "AC not working" }, { text: "third time" }],
    });
    expect(d).toContain("CMP-0007");
    expect(d).toContain("Rahul S. (TWV-C-0150)");
    expect(d).toContain("- AC not working");
    expect(d).toContain("- third time");
  });
});
