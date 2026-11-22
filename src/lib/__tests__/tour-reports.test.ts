import { describe, it, expect } from "vitest";
import { canWorkTour, photoPathOk, reportProblem } from "../tour-reports";

const people = { hostId: "h", accompanierId: "a", createdBy: "c", leadOwnerId: "o", inchargeIds: ["i1", "i2"] };

describe("canWorkTour", () => {
  it("lets admins, managers and sales roles work any tour", () => {
    for (const r of ["admin", "manager", "sales_rep"]) expect(canWorkTour(r, "x", people)).toBe(true);
  });
  it("lets a floor incharge work tours at their own centre, or as host or accompanier", () => {
    expect(canWorkTour("floor_manager", "i2", people)).toBe(true);
    expect(canWorkTour("floor_manager", "h", people)).toBe(true);
    expect(canWorkTour("floor_manager", "a", people)).toBe(true);
    expect(canWorkTour("floor_manager", "stranger", people)).toBe(false);
  });
  it("keeps everyone else out", () => {
    for (const r of ["accounts", "fms", "coordinator", null, undefined]) expect(canWorkTour(r, "h", people)).toBe(false);
  });
});

describe("reportProblem", () => {
  const ok = { outcome: "keen", comments: "Liked the cabin", photoPaths: ["tour-reports/t/1.jpg"] };
  it("accepts a complete report", () => expect(reportProblem(ok)).toBeNull());
  it("asks for what is missing, in order", () => {
    expect(reportProblem({ ...ok, outcome: null })).toBe("Pick how the visit went");
    expect(reportProblem({ ...ok, outcome: "great" })).toBe("Pick how the visit went");
    expect(reportProblem({ ...ok, comments: "  " })).toBe("Add a comment about the visit");
    expect(reportProblem({ ...ok, photoPaths: [] })).toBe("Add at least one photo");
    expect(reportProblem({ ...ok, photoPaths: Array(13).fill("p") })).toBe("At most 12 photos");
  });
});

describe("photoPathOk", () => {
  it("only accepts files under the tour's own folder", () => {
    expect(photoPathOk("t1", "tour-reports/t1/a.jpg")).toBe(true);
    expect(photoPathOk("t1", "tour-reports/t2/a.jpg")).toBe(false);
    expect(photoPathOk("t1", "tour-reports/t1/../t2/a.jpg")).toBe(false);
    expect(photoPathOk("t1", "facility/a.jpg")).toBe(false);
  });
});
