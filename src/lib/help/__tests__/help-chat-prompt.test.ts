import { describe, it, expect } from "vitest";
import { buildHelpChatSystemPrompt } from "../help-chat-prompt";
import type { SectionMatch } from "../help-search";
import type { RolePermission } from "@/lib/help-content";
import { Receipt } from "lucide-react";

const ROLE_PERMISSIONS: RolePermission[] = [
  { feature: "Approve vendor bills", admin: true, manager: false, sales_rep: false, floor_manager: false },
  { feature: "Create leads", admin: true, manager: true, sales_rep: true, floor_manager: false },
];

function invoiceMatch(): SectionMatch {
  return {
    section: {
      id: "invoices",
      title: "Invoices (Proforma)",
      icon: Receipt,
      overview: "Generate proforma invoices for clients.",
      workflows: [],
      tips: [],
      faqs: [],
      roles: null,
    },
    wholeSectionMatch: true,
    matchedWorkflows: [
      { title: "Sending via WhatsApp", steps: [{ step: 1, title: "Tick the checkbox", description: "In the email dialog." }] },
    ],
    matchedTips: [],
    matchedFaqs: [],
    score: 5,
  };
}

describe("buildHelpChatSystemPrompt", () => {
  it("includes matched section content and the role-permissions table verbatim", () => {
    const prompt = buildHelpChatSystemPrompt({
      roleLabel: "Sales Rep",
      matches: [invoiceMatch()],
      globalFaqs: [],
      rolePermissions: ROLE_PERMISSIONS,
      supportEmail: "contact@theworkvilla.com",
      supportPhone: "+91 97910 97900",
    });

    expect(prompt).toContain("Sending via WhatsApp");
    expect(prompt).toContain("Tick the checkbox");
    expect(prompt).toContain("Approve vendor bills: admin");
    expect(prompt).toContain("Create leads: admin, manager, sales_rep");
  });

  it("never includes a restricted section's steps when it wasn't part of the matches", () => {
    // Simulates the real gating: role-filtering already dropped a restricted
    // section (e.g. "Procurement") before scoring/matching ran, so its
    // workflow detail can't appear here even if the question mentions it.
    const prompt = buildHelpChatSystemPrompt({
      roleLabel: "Sales Rep",
      matches: [], // nothing survived role-filtering + matching for this query
      globalFaqs: [],
      rolePermissions: ROLE_PERMISSIONS,
      supportEmail: "contact@theworkvilla.com",
      supportPhone: "+91 97910 97900",
    });

    expect(prompt).not.toContain("Tick the checkbox"); // no workflow step detail leaked in
    expect(prompt).toContain("not sure");
    expect(prompt).toContain("Approve vendor bills: admin"); // still named as who can do it
  });

  it("falls back to 'no one via this list' when a permission row has no true columns", () => {
    const prompt = buildHelpChatSystemPrompt({
      roleLabel: "Admin",
      matches: [],
      globalFaqs: [],
      rolePermissions: [{ feature: "Something locked", admin: false, manager: false, sales_rep: false, floor_manager: false }],
      supportEmail: "contact@theworkvilla.com",
      supportPhone: "+91 97910 97900",
    });

    expect(prompt).toContain("Something locked: no one via this list");
  });
});
