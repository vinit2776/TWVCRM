import { describe, it, expect } from "vitest";
import { wizardChoices, canUseInvoiceWizard } from "@/lib/invoice-wizard-availability";

describe("wizardChoices", () => {
  it("offers every card on an active contract to an admin", () => {
    expect(wizardChoices("active", "admin")).toEqual(["rent", "usage", "electricity", "deposit", "addon", "other"]);
  });

  it("hides Something else from accounts, who can't create invoices", () => {
    expect(wizardChoices("active", "accounts")).toEqual(["rent", "usage", "electricity", "deposit", "addon"]);
  });

  it("offers only add-ons and one-offs before activation (no rent, usage, electricity or deposit)", () => {
    for (const status of ["draft", "sent", "viewed", "accepted"]) {
      expect(wizardChoices(status, "manager")).toEqual(["addon", "other"]);
    }
  });

  it("keeps usage, electricity and one-offs after expiry but drops rent, deposit and add-ons", () => {
    expect(wizardChoices("expired", "admin")).toEqual(["usage", "electricity", "other"]);
  });

  it("keeps usage and one-offs on a terminated contract", () => {
    expect(wizardChoices("terminated", "admin")).toEqual(["usage", "other"]);
  });

  it("offers nothing for a rejected or withdrawn contract", () => {
    expect(wizardChoices("rejected", "admin")).toEqual([]);
    expect(wizardChoices("withdrawn", "admin")).toEqual([]);
  });

  it("offers nothing without a role", () => {
    expect(wizardChoices("active", null)).toEqual([]);
    expect(wizardChoices("active", undefined)).toEqual([]);
  });

  it("rent follows the statuses the rent generator bills, including a renewal in progress", () => {
    expect(wizardChoices("renewal_in_progress", "admin")).toContain("rent");
    expect(wizardChoices("renewed", "admin")).toContain("rent");
  });
});

describe("canUseInvoiceWizard", () => {
  it("shows for billing roles on contracts with something to do", () => {
    expect(canUseInvoiceWizard("active", "admin")).toBe(true);
    expect(canUseInvoiceWizard("draft", "accounts")).toBe(true);
    expect(canUseInvoiceWizard("expired", "manager")).toBe(true);
  });

  it("hides when no card applies", () => {
    expect(canUseInvoiceWizard("rejected", "admin")).toBe(false);
    expect(canUseInvoiceWizard("withdrawn", "manager")).toBe(false);
  });

  it("stays hidden for roles outside the wizard's audience, even if they could create invoices", () => {
    expect(canUseInvoiceWizard("active", "sales_rep")).toBe(false);
    expect(canUseInvoiceWizard("active", "floor_manager")).toBe(false);
  });
});
