import { describe, it, expect } from "vitest";
import {
  computeChecklist,
  confirmationDeadline,
  draftSecondRequest,
  markBlocker,
  noticeApproved,
  placeKindForPurpose,
  releaseBadge,
  type DocSummary,
  type StepMarks,
} from "@/lib/vo-non-renewal";

const NOW = "2026-11-01T00:00:00.000Z";
const approvedDocs: DocSummary[] = [
  { document_type: "discontinuation_notice", status: "dispatched" },
  { document_type: "dos_donts", status: "approved" },
];
const mark = (done_at: string, status: "done" | "issue" = "done") => ({ done_at, status });

describe("placeKindForPurpose", () => {
  it("separates principal, additional and none", () => {
    expect(placeKindForPurpose("gst_new")).toBe("principal");
    expect(placeKindForPurpose("gst_registration")).toBe("principal");
    expect(placeKindForPurpose("gst_existing")).toBe("additional");
    expect(placeKindForPurpose("branch_office")).toBe("additional");
    expect(placeKindForPurpose("mail_handling")).toBe("none");
    expect(placeKindForPurpose(null)).toBe("none");
  });
});

describe("noticeApproved", () => {
  it("needs every client document out of draft", () => {
    expect(noticeApproved([])).toBe(false);
    expect(noticeApproved([{ document_type: "authority_letter", status: "approved" }])).toBe(false);
    expect(noticeApproved([{ document_type: "dos_donts", status: "draft" }, ...approvedDocs])).toBe(false);
    expect(noticeApproved(approvedDocs)).toBe(true);
  });
});

describe("confirmation deadline", () => {
  it("is 15 days after the request", () => {
    expect(confirmationDeadline("2026-10-01T00:00:00.000Z")).toBe("2026-10-16T00:00:00.000Z");
  });
  it("marks the confirmation step overdue after the deadline", () => {
    const marks: StepMarks = { services_off: mark(NOW), delivered: mark(NOW), confirmation_requested: mark("2026-10-10T00:00:00.000Z") };
    const r = computeChecklist({ purpose: "gst_new", docs: approvedDocs, marks, now: NOW });
    expect(r.overdue).toBe(true);
    expect(r.steps.find((s) => s.key === "confirmation")?.state).toBe("overdue");
  });
  it("stays open inside the deadline", () => {
    const marks: StepMarks = { delivered: mark(NOW), confirmation_requested: mark("2026-10-25T00:00:00.000Z") };
    const r = computeChecklist({ purpose: "gst_new", docs: approvedDocs, marks, now: NOW });
    expect(r.overdue).toBe(false);
    expect(r.steps.find((s) => s.key === "confirmation")?.state).toBe("open");
  });
});

describe("releaseBadge", () => {
  it("walks not released, awaiting, confirmed, released", () => {
    expect(releaseBadge({ kind: "principal", marks: {} })).toBe("not_released");
    expect(releaseBadge({ kind: "principal", marks: { confirmation_requested: mark(NOW) } })).toBe("awaiting_confirmation");
    expect(releaseBadge({ kind: "principal", marks: { confirmation_requested: mark(NOW), confirmation_received: mark(NOW) } })).toBe("confirmed");
    expect(releaseBadge({ kind: "principal", marks: { confirmation_received: mark(NOW), gst_portal_check: mark(NOW) } })).toBe("released");
  });
  it("is not released while the portal still shows our address", () => {
    expect(releaseBadge({ kind: "additional", marks: { confirmation_received: mark(NOW), gst_portal_check: mark(NOW, "issue") } })).toBe("confirmed");
  });
  it("releases a non-GST purpose on confirmation alone", () => {
    expect(releaseBadge({ kind: "none", marks: { confirmation_received: mark(NOW) } })).toBe("released");
  });
});

describe("markBlocker", () => {
  const base = { docs: approvedDocs, now: NOW, kind: "principal" as const };
  it("orders delivery after approval and request after delivery", () => {
    expect(markBlocker("delivered", { ...base, docs: [], marks: {} })).not.toBeNull();
    expect(markBlocker("delivered", { ...base, marks: {} })).toBeNull();
    expect(markBlocker("confirmation_requested", { ...base, marks: {} })).not.toBeNull();
    expect(markBlocker("confirmation_requested", { ...base, marks: { delivered: mark(NOW) } })).toBeNull();
  });
  it("opens the second request only after the deadline", () => {
    const early = { confirmation_requested: mark("2026-10-25T00:00:00.000Z") };
    const late = { confirmation_requested: mark("2026-10-10T00:00:00.000Z") };
    expect(markBlocker("confirmation_second_request", { ...base, marks: early })).not.toBeNull();
    expect(markBlocker("confirmation_second_request", { ...base, marks: late })).toBeNull();
  });
  it("blocks the portal check until confirmed or the letter is posted, and for non-GST", () => {
    expect(markBlocker("gst_portal_check", { ...base, marks: {} })).not.toBeNull();
    expect(markBlocker("gst_portal_check", { ...base, marks: { confirmation_received: mark(NOW) } })).toBeNull();
    expect(markBlocker("gst_portal_check", { ...base, docs: [{ document_type: "authority_letter", status: "dispatched" }], marks: {} })).toBeNull();
    expect(markBlocker("gst_portal_check", { ...base, kind: "none", marks: { confirmation_received: mark(NOW) } })).not.toBeNull();
  });
});

describe("principal versus additional place", () => {
  it("describes a different removal route", () => {
    const p = computeChecklist({ purpose: "gst_new", docs: [], marks: {}, now: NOW });
    const a = computeChecklist({ purpose: "gst_existing", docs: [], marks: {}, now: NOW });
    expect(p.steps.find((s) => s.key === "gst_portal_check")?.detail).toMatch(/alternative principal place/);
    expect(a.steps.find((s) => s.key === "gst_portal_check")?.detail).toMatch(/amends the registration/);
  });
  it("skips the portal check for purposes without a GST place", () => {
    const r = computeChecklist({ purpose: "mail_handling", docs: [], marks: {}, now: NOW });
    expect(r.steps.find((s) => s.key === "gst_portal_check")?.state).toBe("skipped");
  });
});

describe("draftSecondRequest", () => {
  it("only produces text", () => {
    const d = draftSecondRequest({ clientName: "Orbit", caseNumber: "C-1", locationName: "Branch A", kind: "additional", requestedAt: "2026-10-10T00:00:00.000Z" });
    expect(d.body).toMatch(/remove our address as an additional place/);
    expect(d.subject).toMatch(/C-1/);
  });
});
