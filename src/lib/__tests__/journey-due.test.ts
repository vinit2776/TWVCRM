import { describe, it, expect } from "vitest";
import { dueDateFor, dueInfo, dueLabel, ONBOARDING_DUE_KEYS } from "../journey/due";
import { selectLateAlerts } from "../journey/late-alerts";
import { computeJourney } from "../journey/compute";
import type { OpenJourney } from "../journey/open-journeys";
import type { Journey, JourneyInput } from "../journey/types";

describe("due dates", () => {
  it("is activation day (IST) plus 2 days", () => {
    expect(dueDateFor("2026-10-14T05:00:00Z")).toBe("2026-10-16");
    // 20:00 UTC is already the next day in IST.
    expect(dueDateFor("2026-10-14T20:00:00Z")).toBe("2026-10-17");
  });

  it("labels today, upcoming and late", () => {
    const now = new Date("2026-10-16T05:00:00Z");
    expect(dueInfo("2026-10-16", now).state).toBe("today");
    expect(dueInfo("2026-10-17", now).state).toBe("upcoming");
    expect(dueLabel("2026-10-16", now)).toBe("Due today");
    expect(dueLabel("2026-10-15", now)).toBe("1 day late");
    expect(dueLabel("2026-10-13", now)).toBe("3 days late");
    expect(dueLabel("2026-10-18", now)).toMatch(/^Due 18 Oct/);
  });

  it("does not give the activation step itself a due date", () => {
    expect(ONBOARDING_DUE_KEYS.has("activated")).toBe(false);
    expect(ONBOARDING_DUE_KEYS.has("wifi_vouchers")).toBe(true);
  });
});

function input(activatedAt: string | null): JourneyInput {
  return {
    leadId: "l1", leadStatus: "won", enquiry: null, proposal: null,
    contract: {
      id: "c1", number: "TWV-C-1", status: "active", isRenewal: true, seats: 2, signedDocumentId: "d",
      stamped: false, activated: !!activatedAt, activatedAt, welcomeDone: false, kycTotal: 0, kycOutstanding: 0,
      spacesAllocated: 2, members: 2, vouchersActive: 0, hasContractLevelVoucher: false,
      accessDevices: 1, membersWithAccess: 0, rentStatementExists: false,
    },
  };
}

describe("journey steps carry due dates", () => {
  it("sets due on open onboarding steps once activated, never on done ones", () => {
    const j = computeJourney(input("2026-10-14T05:00:00Z"));
    const steps = j.phases.flatMap((p) => p.steps);
    expect(steps.find((s) => s.key === "wifi_vouchers")?.due).toBe("2026-10-16");
    // Welcome is blocked behind vouchers and access, so it is not due yet.
    expect(steps.find((s) => s.key === "welcome_done")?.due).toBeUndefined();
    expect(steps.find((s) => s.key === "seats_assigned")?.due).toBeUndefined(); // done
    expect(steps.find((s) => s.key === "activated")?.due).toBeUndefined();
  });

  it("sets no due dates before activation", () => {
    const j = computeJourney(input(null));
    expect(j.phases.flatMap((p) => p.steps).some((s) => s.due)).toBe(false);
  });
});

describe("selectLateAlerts", () => {
  const mk = (activatedAt: string): OpenJourney => ({
    leadId: "l1", customer: "Acme", ref: "TWV-C-1", contractId: "c1", since: activatedAt, activatedAt,
    assignedTo: "u-rep", journey: computeJourney(input(activatedAt)) as Journey,
  });

  it("flags open steps past due, with owner and the assigned rep", () => {
    const got = selectLateAlerts([mk("2026-10-10T05:00:00Z")], new Date("2026-10-16T05:00:00Z"));
    const keys = got.map((g) => g.stepKey).sort();
    expect(keys).toEqual(["door_access", "wifi_vouchers"]); // welcome is still blocked behind them
    expect(got.find((g) => g.stepKey === "wifi_vouchers")?.owner).toBe("it");
    expect(got.find((g) => g.stepKey === "wifi_vouchers")?.assignedTo).toBe("u-rep");
    expect(got[0].title).toMatch(/^Late: /);
  });

  it("flags nothing that is not yet late, or on contracts activated over 14 days ago", () => {
    expect(selectLateAlerts([mk("2026-10-15T05:00:00Z")], new Date("2026-10-16T05:00:00Z"))).toEqual([]);
    expect(selectLateAlerts([mk("2026-09-01T05:00:00Z")], new Date("2026-10-16T05:00:00Z"))).toEqual([]);
  });
});
