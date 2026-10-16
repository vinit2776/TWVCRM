import { describe, it, expect } from "vitest";
import {
  buildJourney,
  classifyEscalation,
  contractRan,
  diffDays,
  diffMonths,
  effectiveEnd,
  rentStepsForContract,
  todayYmdIst,
  type JourneyContractRow,
} from "@/lib/customer-value/journey";

function contract(over: Partial<JourneyContractRow> & { id: string }): JourneyContractRow {
  return {
    contract_number: `TWV-C-${over.id}`,
    status: "expired",
    start_date: "2025-04-01",
    end_date: "2025-10-31",
    activated_at: "2025-04-01T04:00:00Z",
    terminated_at: null,
    seats: 12,
    subtotal: 60000,
    escalation_percentage: 10,
    escalation_waived: false,
    escalation_approval_status: null,
    parent_contract_id: null,
    renewal_sequence: 1,
    days_extended: 0,
    phase_start_date: null,
    renewal_declined: false,
    renewal_agreed_note: null,
    rate_phases: [],
    ...over,
  };
}

const LEAD = { created_at: "2024-12-10T05:00:00Z", source: "referral" };
const TODAY = "2026-10-16";

describe("contractRan", () => {
  it("counts an activated contract", () => {
    expect(contractRan({ status: "terminated", activated_at: "2025-04-01T00:00:00Z" })).toBe(true);
  });
  it("excludes a withdrawn contract (terminated, never activated)", () => {
    expect(contractRan({ status: "terminated", activated_at: null })).toBe(false);
  });
  it("excludes drafts and rejected contracts", () => {
    expect(contractRan({ status: "draft", activated_at: null })).toBe(false);
    expect(contractRan({ status: "rejected", activated_at: null })).toBe(false);
  });
  it("accepts a legacy row whose status can only follow activation", () => {
    expect(contractRan({ status: "expired", activated_at: null })).toBe(true);
    expect(contractRan({ status: "active", activated_at: null })).toBe(true);
  });
});

describe("effectiveEnd", () => {
  it("uses end_date for a normal contract", () => {
    expect(effectiveEnd({ status: "expired", end_date: "2025-10-31", terminated_at: null })).toBe("2025-10-31");
  });
  it("uses the earlier termination date when the customer left early", () => {
    expect(effectiveEnd({ status: "terminated", end_date: "2025-10-31", terminated_at: "2025-08-15T06:00:00Z" })).toBe("2025-08-15");
  });
  it("ignores a termination date after end_date", () => {
    expect(effectiveEnd({ status: "terminated", end_date: "2025-10-31", terminated_at: "2025-12-01T06:00:00Z" })).toBe("2025-10-31");
  });
});

describe("date helpers", () => {
  it("diffDays counts calendar days", () => {
    expect(diffDays("2025-10-31", "2025-11-01")).toBe(1);
    expect(diffDays("2025-11-01", "2025-10-31")).toBe(-1);
  });
  it("diffMonths counts whole months and never goes negative", () => {
    expect(diffMonths("2025-04-01", "2026-10-16")).toBe(18);
    expect(diffMonths("2025-04-20", "2026-10-16")).toBe(17);
    expect(diffMonths("2026-10-16", "2025-04-01")).toBe(0);
  });
  it("todayYmdIst reads the date in IST", () => {
    // 20:00 UTC on the 15th is already the 16th in IST.
    expect(todayYmdIst(new Date("2026-10-15T20:00:00Z"))).toBe("2026-10-16");
  });
});

describe("classifyEscalation", () => {
  it("accepted when agreed meets the ask", () => {
    expect(classifyEscalation(10, 10, false)).toBe("accepted");
    expect(classifyEscalation(10, 12, false)).toBe("accepted");
  });
  it("reduced when agreed is below the ask but above zero", () => {
    expect(classifyEscalation(10, 5, false)).toBe("reduced");
  });
  it("avoided when nothing was agreed or the waiver flag is set", () => {
    expect(classifyEscalation(10, 0, false)).toBe("avoided");
    expect(classifyEscalation(10, 10, true)).toBe("avoided");
  });
  it("unknown when either side is unrecorded", () => {
    expect(classifyEscalation(null, 5, false)).toBe("unknown");
    expect(classifyEscalation(10, null, false)).toBe("unknown");
  });
});

describe("rentStepsForContract", () => {
  it("returns one step for a flat-rate contract", () => {
    const steps = rentStepsForContract(contract({ id: "1" }));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ from: "2025-04-01", to: "2025-10-31", monthlyRent: 60000, perSeat: 5000 });
  });
  it("splits a tiered contract at its phase boundaries", () => {
    const steps = rentStepsForContract(
      contract({
        id: "2",
        start_date: "2025-04-01",
        end_date: "2026-03-31",
        rate_phases: [
          { phase_order: 1, duration_months: 6, monthly_rate: 54000 },
          { phase_order: 2, duration_months: 6, monthly_rate: 60000 },
        ],
      })
    );
    expect(steps.map((s) => s.monthlyRent)).toEqual([54000, 60000]);
    expect(steps[0].to).toBe("2025-09-30");
    expect(steps[1].from).toBe("2025-10-01");
  });
  it("clips steps to the days the customer held the contract", () => {
    const steps = rentStepsForContract(
      contract({ id: "3", status: "terminated", end_date: "2025-10-31", terminated_at: "2025-06-15T06:00:00Z" })
    );
    expect(steps[0].to).toBe("2025-06-15");
  });
  it("leaves perSeat null when seats are unknown", () => {
    expect(rentStepsForContract(contract({ id: "4", seats: null }))[0].perSeat).toBeNull();
  });
});

describe("buildJourney", () => {
  it("reports no history for a lead with only drafts and withdrawn contracts", () => {
    const j = buildJourney({
      lead: LEAD,
      today: TODAY,
      contracts: [
        contract({ id: "w", status: "terminated", activated_at: null }),
        contract({ id: "d", status: "draft", activated_at: null }),
      ],
    });
    expect(j.hasHistory).toBe(false);
    expect(j.customerSince).toBeNull();
    expect(j.ranContractCount).toBe(0);
    expect(j.renewalCount).toBe(0);
  });

  it("describes a seamless renewal with no break", () => {
    const first = contract({ id: "a", start_date: "2025-04-01", end_date: "2025-10-31", status: "renewed" });
    const second = contract({
      id: "b",
      status: "active",
      start_date: "2025-11-01",
      end_date: "2026-12-31",
      parent_contract_id: "a",
      renewal_sequence: 2,
      seats: 14,
      subtotal: 79800,
      escalation_percentage: 5,
      activated_at: "2025-11-01T04:00:00Z",
    });
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [second, first] });
    expect(j.hasHistory).toBe(true);
    expect(j.customerSince).toBe("2025-04-01");
    expect(j.ranContractCount).toBe(2);
    expect(j.renewalCount).toBe(1);
    expect(j.breakCount).toBe(0);
    expect(j.longestGapDays).toBe(0);
    expect(j.daysToFirstContract).toBe(diffDays("2024-12-10", "2025-04-01"));
    expect(j.current).toMatchObject({ contractNumber: "TWV-C-b", daysToEnd: diffDays(TODAY, "2026-12-31") });
  });

  it("finds a gap between contracts", () => {
    const first = contract({ id: "a", start_date: "2025-04-01", end_date: "2025-09-30", status: "expired" });
    const second = contract({
      id: "b",
      status: "active",
      start_date: "2025-11-01",
      end_date: "2026-10-31",
      parent_contract_id: "a",
    });
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [first, second] });
    expect(j.breakCount).toBe(1);
    expect(j.gaps[0]).toMatchObject({ from: "2025-10-01", to: "2025-10-31", days: 31 });
    expect(j.longestGapDays).toBe(31);
  });

  it("does not report overlapping contracts as a break", () => {
    const a = contract({ id: "a", start_date: "2025-04-01", end_date: "2026-03-31", status: "active" });
    const b = contract({ id: "b", start_date: "2025-10-01", end_date: "2026-09-30", status: "active" });
    expect(buildJourney({ lead: LEAD, today: TODAY, contracts: [a, b] }).breakCount).toBe(0);
  });

  it("sums extensions across contracts", () => {
    const a = contract({ id: "a", days_extended: 12 });
    const b = contract({ id: "b", start_date: "2025-11-01", end_date: "2026-10-31", status: "active", days_extended: 0 });
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [a, b] });
    expect(j.extension).toMatchObject({ events: 1, totalDays: 12, latestUsedDays: 0, lifetimeCap: 60 });
  });

  it("compares the parent's clause with the renewal's agreed escalation", () => {
    const a = contract({ id: "a", escalation_percentage: 10, subtotal: 60000, seats: 12 });
    const b = contract({
      id: "b",
      status: "active",
      start_date: "2025-11-01",
      end_date: "2026-10-31",
      parent_contract_id: "a",
      escalation_percentage: 5,
      subtotal: 63000,
      seats: 12,
    });
    const e = buildJourney({ lead: LEAD, today: TODAY, contracts: [a, b] }).escalations[0];
    expect(e).toMatchObject({ askedPct: 10, agreedPct: 5, outcome: "reduced", parentContractNumber: "TWV-C-a" });
    expect(e.rentPerSeatChangePct).toBeCloseTo(5, 5);
  });

  it("flags a waived escalation and keeps the approval status", () => {
    const a = contract({ id: "a", escalation_percentage: 10 });
    const b = contract({
      id: "b",
      status: "active",
      start_date: "2025-11-01",
      end_date: "2026-10-31",
      parent_contract_id: "a",
      escalation_percentage: 0,
      escalation_waived: true,
      escalation_approval_status: "approved",
    });
    const e = buildJourney({ lead: LEAD, today: TODAY, contracts: [a, b] }).escalations[0];
    expect(e).toMatchObject({ outcome: "avoided", waived: true, approvalStatus: "approved" });
  });

  it("surfaces a pending renewal draft against the live contract", () => {
    const live = contract({ id: "a", status: "renewal_in_progress", start_date: "2025-11-01", end_date: "2026-12-31" });
    const draft = contract({
      id: "d",
      status: "draft",
      activated_at: null,
      start_date: "2027-01-01",
      end_date: "2027-12-31",
      parent_contract_id: "a",
    });
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [live, draft] });
    expect(j.current?.renewalDraftStatus).toBe("draft");
    expect(j.bars.find((b) => b.id === "d")?.kind).toBe("pending");
    expect(j.axis.to >= "2027-12-31").toBe(true);
  });

  it("adds an enquiry bar from lead creation to the first contract", () => {
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [contract({ id: "a" })] });
    const enquiry = j.bars.find((b) => b.kind === "enquiry");
    expect(enquiry).toMatchObject({ from: "2024-12-10", to: "2025-03-31" });
  });

  it("treats the contract covering today as current even when it is already marked renewed", () => {
    const old = contract({ id: "a", status: "renewed", start_date: "2026-01-01", end_date: "2026-10-31" });
    const next = contract({
      id: "b",
      status: "active",
      start_date: "2026-11-01",
      end_date: "2027-10-31",
      parent_contract_id: "a",
    });
    const j = buildJourney({ lead: LEAD, today: TODAY, contracts: [old, next] });
    expect(j.current).toMatchObject({ contractNumber: "TWV-C-a", daysToEnd: 15, renewalDraftStatus: "active" });
  });

  it("has no current contract when today falls in a gap", () => {
    const old = contract({ id: "a", status: "expired", start_date: "2025-04-01", end_date: "2026-09-30" });
    expect(buildJourney({ lead: LEAD, today: TODAY, contracts: [old] }).current).toBeNull();
  });

  it("carries the renewal's agreed note into the escalation event, trimmed", () => {
    const a = contract({ id: "a", escalation_percentage: 10 });
    const b = contract({
      id: "b",
      status: "active",
      start_date: "2025-11-01",
      end_date: "2026-10-31",
      parent_contract_id: "a",
      escalation_percentage: 5,
      renewal_agreed_note: "  Held 5% for two extra seats.\nSigned 12 months.  ",
    });
    const e = buildJourney({ lead: LEAD, today: TODAY, contracts: [a, b] }).escalations[0];
    expect(e.agreedNote).toBe("Held 5% for two extra seats.\nSigned 12 months.");
  });

  it("leaves the agreed note null when none was recorded or it is blank", () => {
    const a = contract({ id: "a" });
    const none = contract({ id: "b", status: "active", start_date: "2025-11-01", end_date: "2026-10-31", parent_contract_id: "a" });
    expect(buildJourney({ lead: LEAD, today: TODAY, contracts: [a, none] }).escalations[0].agreedNote).toBeNull();
    const blank = { ...none, renewal_agreed_note: "   " };
    expect(buildJourney({ lead: LEAD, today: TODAY, contracts: [a, blank] }).escalations[0].agreedNote).toBeNull();
  });
});
