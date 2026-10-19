import { describe, it, expect } from "vitest";
import {
  historyDates,
  overdueInvoicesAt,
  primaryLocation,
  scoreCustomersAt,
  toScoreRecord,
  type RunCustomer,
} from "@/lib/customer-value/scoring-run";
import type { CustomerRaw, RawStatement } from "@/lib/customer-value/monthly-metrics";
import type { JourneyContractRow } from "@/lib/customer-value/journey";
import type { MoneyPaymentRow } from "@/lib/customer-value/money";
import { DEFAULT_SCORING_SETTINGS as S, mergeSettings } from "@/lib/customer-value/scoring-settings";

const TODAY = "2026-10-31";

function contract(id: string, over: Partial<JourneyContractRow> = {}): JourneyContractRow {
  return {
    id,
    contract_number: `TWV-C-${id}`,
    status: "active",
    start_date: "2026-01-01",
    end_date: "2027-12-31",
    activated_at: "2026-01-01T04:00:00Z",
    terminated_at: null,
    seats: 10,
    subtotal: 50000,
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

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

/** Nine rent invoices, one a month, each due on the 7th of the next month and paid `lateBy(i)` days after. */
function payer(lateBy: (i: number) => number, idPrefix: string): Pick<CustomerRaw, "statements" | "payments"> {
  const statements: RawStatement[] = [];
  const payments: MoneyPaymentRow[] = [];
  MONTHS.forEach((ym, i) => {
    const [y, m] = ym.split("-").map(Number);
    const due = m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, "0")}-07`;
    const id = `${idPrefix}-${ym}`;
    statements.push({ id, period_start: `${ym}-01`, subtotal: 50000, total_amount: 59000, status: "finalized", due_date: due, finalized_at: `${ym}-25T06:00:00Z` });
    const paid = new Date(Date.UTC(Number(due.slice(0, 4)), Number(due.slice(5, 7)) - 1, Number(due.slice(8, 10)) + lateBy(i))).toISOString().slice(0, 10);
    payments.push({ billing_statement_id: id, amount: 59000, tds_amount: 0, payment_date: paid, created_at: `${paid}T06:00:00Z` });
  });
  return { statements, payments };
}

function customer(leadId: string, location: string | null, lateBy: (i: number) => number, over: Partial<CustomerRaw> = {}): RunCustomer {
  return {
    leadId,
    locationIds: location ? [location] : [],
    ticketLinkCoverage: null,
    raw: {
      contracts: [contract(`${leadId}-c`)],
      ...payer(lateBy, leadId),
      reminders: [],
      concessions: [],
      bookings: [],
      tickets: [],
      billingQueries: [],
      door: null,
      ...over,
    },
  };
}

const best = (customers: ReturnType<typeof scoreCustomersAt>, lead: string, i = 0) => {
  const list = customers.get(lead);
  if (!list) throw new Error(`no scores for ${lead}`);
  return list[i];
};

describe("primaryLocation", () => {
  it("is the first location by id, so the choice is stable", () => {
    expect(primaryLocation({ locationIds: ["b", "a"] })).toBe("a");
    expect(primaryLocation({ locationIds: [] })).toBeNull();
  });
});

describe("historyDates", () => {
  it("steps month ends and finishes on today if the month is unfinished", () => {
    expect(historyDates("2026-08-01", "2026-10-17")).toEqual(["2026-08-31", "2026-09-30", "2026-10-17"]);
  });
});

describe("scoreCustomersAt: cohorts", () => {
  /** Ten customers at one center paying on time, plus one who pays very late. */
  const peers = Array.from({ length: 10 }, (_, i) => customer(`peer${i}`, "loc1", () => 0));
  const late = customer("late", "loc1", () => 14);
  const all = [...peers, late];
  const out = scoreCustomersAt(all, [TODAY], S);

  it("ranks by percentile once the center has enough peers, and says so", () => {
    const m = best(out, "late").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late");
    expect(m).toMatchObject({ method: "percentile", cohortSize: 10 });
    expect(m?.score).toBe(0); // later than all ten peers
    expect(best(out, "peer0").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late")?.method).toBe("percentile");
  });

  it("never ranks a customer against themselves", () => {
    // 11 customers: each one's cohort is the other 10.
    for (const c of all) {
      const m = best(out, c.leadId).score.pillars.payment.metrics.find((x) => x.key === "avg_days_late");
      expect(m?.cohortSize).toBe(10);
    }
  });

  it("falls back to the fixed scale at a small center", () => {
    const small = scoreCustomersAt([customer("a", "tiny", () => 0), customer("b", "tiny", () => 10)], [TODAY], S);
    const m = best(small, "b").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late");
    expect(m?.method).toBe("fixed");
  });

  it("keeps centers apart", () => {
    const mixed = scoreCustomersAt(
      [...peers, customer("elsewhere", "loc2", () => 14)],
      [TODAY],
      S
    );
    const m = best(mixed, "elsewhere").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late");
    expect(m?.cohortSize).toBe(0);
    expect(m?.method).toBe("fixed");
  });

  it("does not count customers too new to be a fair comparison as peers", () => {
    const young = Array.from({ length: 10 }, (_, i) =>
      customer(`new${i}`, "loc1", () => 0, { contracts: [contract(`n${i}`, { start_date: "2026-10-01", activated_at: "2026-10-01T04:00:00Z" })] })
    );
    const out2 = scoreCustomersAt([...young, customer("old", "loc1", () => 5)], [TODAY], S);
    const m = best(out2, "old").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late");
    expect(m?.method).toBe("fixed"); // the ten new customers are not peers
  });

  it("puts a customer with no center in no cohort", () => {
    const solo = scoreCustomersAt([...peers, customer("nowhere", null, () => 5)], [TODAY], S);
    expect(best(solo, "nowhere").score.pillars.payment.metrics.find((x) => x.key === "avg_days_late")?.cohortSize).toBe(0);
  });
});

describe("scoreCustomersAt: replay and trend", () => {
  const drifting = customer("drift", "loc1", (i) => Math.max(0, (i - 2) * 2));
  const dates = ["2026-04-30", "2026-07-31", "2026-10-31"];
  const out = scoreCustomersAt([drifting], dates, S);

  it("produces one score per requested date, in order", () => {
    expect(out.get("drift")?.map((s) => s.asOf)).toEqual(dates);
  });

  it("shows the score falling as the customer pays later", () => {
    const overall = out.get("drift")?.map((s) => s.score.overall as number) ?? [];
    expect(overall[0]).toBeGreaterThan(overall[1]);
    expect(overall[1]).toBeGreaterThan(overall[2]);
  });

  it("reads the trend against 90 days earlier, and calls a real fall a down", () => {
    const last = best(out, "drift", 2);
    expect(last.previousOverall).not.toBeNull();
    expect(last.previousOverall as number).toBeGreaterThan(last.score.overall as number);
    expect(["down", "flat"]).toContain(last.trend);
  });

  it("has no trend when there was nothing to compare against", () => {
    const first = scoreCustomersAt([drifting], ["2026-02-28"], S).get("drift")?.[0];
    expect(first?.trend).toBeNull();
    expect(first?.previousOverall).toBeNull();
  });

  it("scores a past date identically whether or not later history exists", () => {
    const truncated: RunCustomer = {
      ...drifting,
      raw: {
        ...drifting.raw,
        statements: drifting.raw.statements.filter((s) => s.period_start <= "2026-05-31"),
        payments: drifting.raw.payments.filter((p) => p.billing_statement_id <= "drift-2026-05" && (p.payment_date ?? "") <= "2026-06-30"),
      },
    };
    const a = scoreCustomersAt([drifting], ["2026-06-30"], S).get("drift")?.[0];
    const b = scoreCustomersAt([truncated], ["2026-06-30"], S).get("drift")?.[0];
    expect(a?.score.overall).toBe(b?.score.overall);
    expect(a?.trend).toBe(b?.trend);
  });

  it("does not grade a customer with under three months of history", () => {
    const young = customer("young", "loc1", () => 0, { contracts: [contract("y", { start_date: "2026-10-01", activated_at: "2026-10-01T04:00:00Z" })] });
    const s = best(scoreCustomersAt([young], [TODAY], S), "young");
    expect(s.score.status).toBe("not_enough_data");
    expect(s.story.action.code).toBe("not_enough_data");
  });
});

describe("scoreCustomersAt: story", () => {
  it("states open problems, naming the invoices as evidence, and recommends chasing them", () => {
    const owing = customer("owing", "loc1", () => 0);
    // The last invoice, due in October, is never paid.
    owing.raw.payments = owing.raw.payments.filter((p) => p.billing_statement_id !== "owing-2026-09");
    const s = best(scoreCustomersAt([owing], [TODAY], S), "owing");
    const problems = s.story.sentences.find((x) => x.metric === "open_problems");
    expect(problems?.text).toMatch(/1 unpaid invoice, up to 24 days overdue/);
    expect(problems?.evidence).toEqual(["owing-2026-09"]);
    expect(s.story.action.code).toBe("chase_overdue_invoices");
  });

  it("says nothing about open problems when there are none", () => {
    const s = best(scoreCustomersAt([customer("fine", "loc1", () => 0)], [TODAY], S), "fine");
    expect(s.story.sentences.find((x) => x.metric === "open_problems")).toBeUndefined();
  });

  it("applies the weak-pillar cap when it is switched on", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 50, maxTier: "C" } });
    const slow = customer("slow", "loc1", () => 20);
    const without = best(scoreCustomersAt([slow], [TODAY], S), "slow");
    const withCap = best(scoreCustomersAt([slow], [TODAY], capped), "slow");
    expect(without.score.tierCap).toBeNull();
    expect(["C", "D"]).toContain(withCap.score.tier);
  });
});

describe("overdueInvoicesAt", () => {
  // Every invoice is paid five days after its due date, so January's (due 7 Feb) was paid on 12 Feb.
  const raw = customer("o", "loc1", () => 5).raw;

  it("counts an invoice as overdue from the day after its due date until the payment that was known by then", () => {
    expect(overdueInvoicesAt(raw, "2026-02-07").count).toBe(0); // due today, not overdue yet
    expect(overdueInvoicesAt(raw, "2026-02-10")).toMatchObject({ count: 1, maxDays: 3, ids: ["o-2026-01"] });
    expect(overdueInvoicesAt(raw, "2026-02-12").count).toBe(0); // paid that day
  });

  it("ignores invoices that are not due yet and statements that are not issued", () => {
    const withDraft = {
      ...raw,
      statements: [...raw.statements, { id: "d", period_start: "2026-09-01", subtotal: 1, total_amount: 1, status: "draft", due_date: "2026-01-01", finalized_at: null }],
    };
    expect(overdueInvoicesAt(withDraft, "2026-02-10").ids).toEqual(["o-2026-01"]);
  });
});

describe("toScoreRecord", () => {
  const scored = best(scoreCustomersAt([customer("rec", "loc1", () => 0)], [TODAY], S), "rec");
  const rec = toScoreRecord(scored, "abcd1234", "2026-10-31T00:00:00Z");

  it("carries the identity, version and timestamp", () => {
    expect(rec).toMatchObject({ lead_id: "rec", as_of: TODAY, settings_version: "abcd1234", computed_at: "2026-10-31T00:00:00Z", status: "graded" });
  });
  it("stores scores to one decimal and confidence to two", () => {
    for (const v of [rec.payment, rec.friction, rec.engagement, rec.profitability, rec.overall]) {
      if (v !== null) expect(Math.round(v * 10) / 10).toBe(v);
    }
    expect(Object.keys(rec.confidence).sort()).toEqual(["engagement", "friction", "payment", "profitability"]);
  });
  it("stores the method behind every metric and the story with its evidence", () => {
    const pillars = (rec.method as { pillars: Record<string, { metrics: Array<{ key: string; method: string | null }> }> }).pillars;
    expect(pillars.payment.metrics.map((m) => m.key)).toContain("avg_days_late");
    expect(rec.story).toHaveProperty("sentences");
    expect(rec.story).toHaveProperty("action");
  });
  it("is the same for the same input", () => {
    expect(toScoreRecord(scored, "abcd1234", "t")).toEqual(toScoreRecord(scored, "abcd1234", "t"));
  });
  it("keeps unknowns null rather than zero", () => {
    const young = best(
      scoreCustomersAt([customer("y", "loc1", () => 0, { contracts: [contract("y", { start_date: "2026-10-01", activated_at: "2026-10-01T04:00:00Z" })] })], [TODAY], S),
      "y"
    );
    const r = toScoreRecord(young, "v", "t");
    expect(r.overall).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.status).toBe("not_enough_data");
    expect(r.reason).toMatch(/months of history/);
  });
});
