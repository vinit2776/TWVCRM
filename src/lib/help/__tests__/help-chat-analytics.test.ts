import { describe, it, expect } from "vitest";
import { summarizeHelpChatInteractions, type HelpChatInteractionRow } from "../help-chat-analytics";
import type { HelpSection } from "@/lib/help-content";
import { Receipt, Wrench } from "lucide-react";

const SECTIONS: HelpSection[] = [
  { id: "invoices", title: "Invoices (Proforma)", icon: Receipt, overview: "", workflows: [], tips: [], faqs: [], roles: null },
  { id: "procurement", title: "Procurement", icon: Wrench, overview: "", workflows: [], tips: [], faqs: [], roles: ["admin", "manager", "floor_manager"] },
];

function row(overrides: Partial<HelpChatInteractionRow>): HelpChatInteractionRow {
  return {
    user_id: "u1",
    role: "sales_rep",
    page_path: "/billing",
    had_match: true,
    section_ids: ["invoices"],
    feedback: null,
    created_at: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeHelpChatInteractions", () => {
  it("computes totals, match rate, and active users", () => {
    const rows = [
      row({ user_id: "u1", had_match: true }),
      row({ user_id: "u1", had_match: true }),
      row({ user_id: "u2", had_match: false, section_ids: [] }),
    ];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, { days: 7 });
    expect(summary.totalQuestions).toBe(3);
    expect(summary.activeUsers).toBe(2);
    expect(summary.matchRate).toBe(67); // 2/3 rounded
  });

  it("computes helpfulRate only over rated answers, not all answers", () => {
    const rows = [
      row({ feedback: "helpful" }),
      row({ feedback: "helpful" }),
      row({ feedback: "not_helpful" }),
      row({ feedback: null }), // unrated — must not count toward the denominator
    ];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, { days: 7 });
    expect(summary.helpfulRate).toBe(67); // 2 of 3 RATED, not 2 of 4 total
    expect(summary.feedback).toEqual({ helpful: 2, notHelpful: 1, unrated: 1 });
  });

  it("ranks byRole, byPage, and bySection descending", () => {
    const rows = [
      row({ role: "sales_rep", page_path: "/billing", section_ids: ["invoices"] }),
      row({ role: "sales_rep", page_path: "/billing", section_ids: ["invoices"] }),
      row({ role: "admin", page_path: "/procurement", section_ids: ["procurement"] }),
    ];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, { days: 7 });
    expect(summary.byRole[0]).toEqual({ role: "sales_rep", count: 2 });
    expect(summary.byPage[0]).toEqual({ path: "/billing", count: 2 });
    expect(summary.bySection[0]).toEqual({ sectionId: "invoices", title: "Invoices (Proforma)", count: 2 });
  });

  it("falls back to the raw section id as title when the section is unknown", () => {
    const rows = [row({ section_ids: ["some-removed-section"] })];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, { days: 7 });
    expect(summary.bySection[0]).toEqual({ sectionId: "some-removed-section", title: "some-removed-section", count: 1 });
  });

  it("only surfaces no-match rate for pages meeting the minimum sample size", () => {
    const rows = [
      // /rare has only 2 questions — below the default min sample of 5, should be excluded
      row({ page_path: "/rare", had_match: false }),
      row({ page_path: "/rare", had_match: false }),
      // /common has 5 questions, 3 with no match — included
      ...Array.from({ length: 3 }, () => row({ page_path: "/common", had_match: false })),
      ...Array.from({ length: 2 }, () => row({ page_path: "/common", had_match: true })),
    ];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, { days: 7 });
    const paths = summary.noMatchRateByPage.map((p) => p.path);
    expect(paths).not.toContain("/rare");
    expect(summary.noMatchRateByPage.find((p) => p.path === "/common")).toEqual({
      path: "/common",
      total: 5,
      noMatchRate: 60,
    });
  });

  it("fills every day in the window, including zero-question days", () => {
    const rows = [row({ created_at: "2026-09-01T10:00:00.000Z" })];
    const summary = summarizeHelpChatInteractions(rows, SECTIONS, {
      days: 3,
      now: new Date("2026-09-01T18:00:00.000Z"),
    });
    expect(summary.dailyTrend).toHaveLength(3);
    expect(summary.dailyTrend[summary.dailyTrend.length - 1].date).toBe("2026-09-01");
    expect(summary.dailyTrend[summary.dailyTrend.length - 1].count).toBe(1);
    expect(summary.dailyTrend[0].count).toBe(0);
  });

  it("handles an empty result set without dividing by zero", () => {
    const summary = summarizeHelpChatInteractions([], SECTIONS, { days: 7 });
    expect(summary.totalQuestions).toBe(0);
    expect(summary.matchRate).toBe(0);
    expect(summary.helpfulRate).toBe(0);
    expect(summary.activeUsers).toBe(0);
  });
});
