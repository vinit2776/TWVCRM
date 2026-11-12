import { describe, it, expect } from "vitest";
import { isSectionVisible, filterSectionsForRole } from "../role-filter";
import type { HelpSection } from "@/lib/help-content";
import { LayoutDashboard } from "lucide-react";

function makeSection(id: string, roles: string[] | null): HelpSection {
  return {
    id,
    title: id,
    icon: LayoutDashboard,
    overview: "",
    workflows: [],
    tips: [],
    faqs: [],
    roles,
  };
}

describe("isSectionVisible", () => {
  it("shows an unrestricted section to anyone, including a signed-out user", () => {
    expect(isSectionVisible(makeSection("dashboard", null), null)).toBe(true);
    expect(isSectionVisible(makeSection("dashboard", null), "sales_rep")).toBe(true);
  });

  it("shows a restricted section only to a role in its list", () => {
    const settings = makeSection("settings", ["admin"]);
    expect(isSectionVisible(settings, "admin")).toBe(true);
    expect(isSectionVisible(settings, "sales_rep")).toBe(false);
  });

  it("hides a restricted section from a signed-out user", () => {
    const settings = makeSection("settings", ["admin"]);
    expect(isSectionVisible(settings, null)).toBe(false);
  });
});

describe("filterSectionsForRole", () => {
  it("keeps unrestricted sections and drops ones the role can't see", () => {
    const sections = [
      makeSection("dashboard", null),
      makeSection("settings", ["admin"]),
      makeSection("procurement", ["admin", "manager", "floor_manager"]),
    ];

    const forSalesRep = filterSectionsForRole(sections, "sales_rep");
    expect(forSalesRep.map((s) => s.id)).toEqual(["dashboard"]);

    const forAdmin = filterSectionsForRole(sections, "admin");
    expect(forAdmin.map((s) => s.id)).toEqual(["dashboard", "settings", "procurement"]);
  });
});
