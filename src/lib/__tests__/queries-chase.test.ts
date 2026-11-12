import { describe, it, expect } from "vitest";
import {
  decideChase,
  daysOverdue,
  ESCALATE_AFTER_HOURS,
  NUDGE_COOLDOWN_HOURS,
  type ChaseInput,
} from "@/lib/queries/chase";

/**
 * The chase rules. Worth pinning down precisely: a reminder loop that
 * misfires trains people to ignore it, and then the reminders that matter
 * don't land either.
 */

const NOW = new Date("2026-08-16T10:00:00Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

function input(over: Partial<ChaseInput> = {}): ChaseInput {
  return {
    status: "open",
    needed_by: null,
    escalated_at: null,
    last_nudged_at: null,
    last_message_at: hoursAgo(1),
    now: NOW,
    ...over,
  };
}

describe("daysOverdue", () => {
  it("counts whole days past the date", () => {
    expect(daysOverdue("2026-08-14", NOW)).toBe(2);
    expect(daysOverdue("2026-08-16", NOW)).toBe(0);
  });

  it("is negative before the date, so future dates never read as overdue", () => {
    expect(daysOverdue("2026-08-20", NOW)).toBeLessThan(0);
  });
});

describe("decideChase — never chases what shouldn't be chased", () => {
  it("leaves resolved threads alone", () => {
    expect(
      decideChase(input({ status: "resolved", needed_by: "2026-08-01", last_message_at: hoursAgo(999) })).kind,
    ).toBe("none");
  });

  it("never nudges a query with no needed_by — that's what makes the date mean something", () => {
    expect(decideChase(input({ needed_by: null, last_message_at: hoursAgo(2) })).kind).toBe("none");
  });

  it("does not nudge before the date arrives", () => {
    expect(decideChase(input({ needed_by: "2026-08-20" })).kind).toBe("none");
  });

  it("does not nudge on the due date itself — only once it's past", () => {
    expect(decideChase(input({ needed_by: "2026-08-16" })).kind).toBe("none");
  });

  it("ignores an empty thread with no messages", () => {
    expect(decideChase(input({ last_message_at: null })).kind).toBe("none");
  });
});

describe("decideChase — escalation on silence", () => {
  it("escalates after the silence threshold", () => {
    expect(decideChase(input({ last_message_at: hoursAgo(ESCALATE_AFTER_HOURS) })).kind).toBe("escalate");
  });

  it("does not escalate just before the threshold", () => {
    expect(decideChase(input({ last_message_at: hoursAgo(ESCALATE_AFTER_HOURS - 1) })).kind).toBe("none");
  });

  it("escalates only once per stretch of silence", () => {
    const silent = { last_message_at: hoursAgo(100) };
    expect(decideChase(input(silent)).kind).toBe("escalate");
    expect(decideChase(input({ ...silent, escalated_at: hoursAgo(10) })).kind).toBe("none");
  });
});

describe("decideChase — nudging on a due date", () => {
  it("nudges an overdue thread that has never been nudged", () => {
    const d = decideChase(input({ needed_by: "2026-08-14" }));
    expect(d.kind).toBe("nudge");
    expect(d.overdueDays).toBe(2);
  });

  it("respects the cooldown so it can't fire every cron run", () => {
    const overdue = { needed_by: "2026-08-14" };
    expect(decideChase(input({ ...overdue, last_nudged_at: hoursAgo(1) })).kind).toBe("none");
    expect(decideChase(input({ ...overdue, last_nudged_at: hoursAgo(NUDGE_COOLDOWN_HOURS) })).kind).toBe("nudge");
  });

  it("pulls in management once well overdue", () => {
    expect(decideChase(input({ needed_by: "2026-08-15" })).involveManagement).toBe(false);
    expect(decideChase(input({ needed_by: "2026-08-13" })).involveManagement).toBe(true);
  });
});

describe("decideChase — when both triggers apply", () => {
  it("prefers escalation, so one run never sends two chases about one thread", () => {
    const d = decideChase(input({ needed_by: "2026-08-10", last_message_at: hoursAgo(100) }));
    expect(d.kind).toBe("escalate");
    expect(d.overdueDays).toBe(6);
    expect(d.involveManagement).toBe(true);
  });

  it("falls back to nudging once the escalation has already fired", () => {
    expect(
      decideChase(
        input({ needed_by: "2026-08-10", last_message_at: hoursAgo(100), escalated_at: hoursAgo(50) }),
      ).kind,
    ).toBe("nudge");
  });
});
