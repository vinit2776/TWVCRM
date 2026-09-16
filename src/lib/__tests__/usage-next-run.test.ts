import { describe, it, expect } from "vitest";
import { nextUsageRun, type NextRunInput, type MonthCoverage } from "@/lib/usage-next-run";

const TODAY = "2026-09-16";
const active = { status: "active", start_date: "2026-01-01", end_date: "2027-06-30" };

function run(over: Partial<NextRunInput> & { cov?: Record<string, MonthCoverage> }) {
  const { cov = {}, ...rest } = over;
  return nextUsageRun({
    chargeDate: "2026-08-20",
    held: false,
    reviewed: false,
    contract: active,
    today: TODAY,
    reviewAfterDays: 60,
    coverageFor: (ym) => cov[`${ym.year}-${ym.month}`] ?? null,
    ...rest,
  });
}

describe("nextUsageRun", () => {
  it("closed-month charge on an unbilled contract is ready now", () => {
    expect(run({})).toEqual({ kind: "ready", label: "Aug 2026 run", note: "Ready — Generate & Send now" });
  });

  it("older charge is swept by the last closed month's run", () => {
    expect(run({ chargeDate: "2026-07-25" }).label).toBe("Aug 2026 run");
  });

  it("current-month charge waits for the month to close", () => {
    expect(run({ chargeDate: "2026-09-08" })).toEqual({ kind: "later", label: "Sep 2026 run", note: "Opens after 30 Sep" });
  });

  it("closed month already sent, no supplement yet → supplement", () => {
    expect(run({ cov: { "2026-8": { sent: true, supplemented: false } } })).toMatchObject({ kind: "supplement", label: "Aug 2026 supplement" });
  });

  it("closed month sent and supplemented → next month's run", () => {
    expect(run({ cov: { "2026-8": { sent: true, supplemented: true } } }))
      .toEqual({ kind: "later", label: "Sep 2026 run", note: "Aug already billed + supplemented" });
  });

  it("an unsent draft for the month doesn't block — the run supersedes it", () => {
    expect(run({ cov: { "2026-8": { sent: false, supplemented: false } } }).kind).toBe("ready");
  });

  it("contract starting after the closed month skips it", () => {
    expect(run({ contract: { status: "active", start_date: "2026-09-01", end_date: "2027-08-31" } }))
      .toEqual({ kind: "later", label: "Sep 2026 run", note: "Aug skipped — contract starts 1 Sep" });
  });

  it("stale unreviewed charge needs review, but still names the run", () => {
    expect(run({ chargeDate: "2026-06-10" })).toEqual({ kind: "review", label: "Not until reviewed", note: "Over 60 days — then Aug 2026 run" });
  });

  it("reviewed stale charge bills normally", () => {
    expect(run({ chargeDate: "2026-06-10", reviewed: true }).kind).toBe("ready");
  });

  it("held wins over everything", () => {
    expect(run({ held: true, chargeDate: "2026-06-10" }).kind).toBe("held");
  });

  it("ended contract won't auto-bill", () => {
    expect(run({ contract: { status: "expired", start_date: "2025-01-01", end_date: "2026-07-31" } }).kind).toBe("none");
  });

  it("renewal_in_progress past its end date still bills", () => {
    expect(run({ contract: { status: "renewal_in_progress", start_date: "2025-01-01", end_date: "2026-06-30" } }).kind).toBe("ready");
  });

  it("no contract → won't auto-bill", () => {
    expect(run({ contract: null }).kind).toBe("none");
  });

  it("year boundary: December closed month in January", () => {
    expect(run({ today: "2027-01-10", chargeDate: "2026-12-05", contract: active }).label).toBe("Dec 2026 run");
  });
});
