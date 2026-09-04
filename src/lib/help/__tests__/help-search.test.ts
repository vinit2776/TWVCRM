import { describe, it, expect } from "vitest";
import { scoreSections, getTopMatches } from "../help-search";
import type { HelpSection } from "@/lib/help-content";
import { LayoutDashboard, Receipt } from "lucide-react";

const SECTIONS: HelpSection[] = [
  {
    id: "invoices",
    title: "Invoices (Proforma)",
    icon: Receipt,
    overview: "Generate proforma invoices for clients, emailed or sent via WhatsApp as a PDF.",
    workflows: [
      {
        title: "Sending via WhatsApp",
        steps: [
          { step: 1, title: "Tick the checkbox", description: "Tick 'Also send via WhatsApp' in the email dialog." },
        ],
      },
    ],
    tips: ["The WhatsApp checkbox is off by default."],
    faqs: [{ question: "Can I send an invoice on WhatsApp?", answer: "Yes, tick the checkbox in the email dialog." }],
    roles: null,
  },
  {
    id: "dashboard",
    title: "Dashboard",
    icon: LayoutDashboard,
    overview: "Your home screen with KPIs and follow-ups.",
    workflows: [],
    tips: [],
    faqs: [],
    roles: null,
  },
];

describe("scoreSections", () => {
  it("returns every section, unscored, for a blank query", () => {
    const matches = scoreSections(SECTIONS, "");
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.score === 0)).toBe(true);
  });

  it("ranks a title match above a query with no match at all", () => {
    const matches = scoreSections(SECTIONS, "invoice");
    expect(matches.map((m) => m.section.id)).toEqual(["invoices"]);
  });

  it("matches inside a workflow step or FAQ even when the title doesn't mention it", () => {
    const matches = scoreSections(SECTIONS, "whatsapp");
    expect(matches).toHaveLength(1);
    expect(matches[0].section.id).toBe("invoices");
    expect(matches[0].matchedFaqs.length).toBeGreaterThan(0);
  });

  it("excludes sections with no match anywhere", () => {
    const matches = scoreSections(SECTIONS, "zzz-nonexistent");
    expect(matches).toHaveLength(0);
  });
});

describe("getTopMatches", () => {
  it("caps the result to the given limit", () => {
    const matches = getTopMatches(SECTIONS, "", 1);
    expect(matches).toHaveLength(1);
  });
});
