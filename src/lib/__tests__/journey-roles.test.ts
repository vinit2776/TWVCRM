import { describe, it, expect } from "vitest";
import { ownersForRole, OWNER_ROLES } from "../journey/roles";
import { DASHBOARD_ROLE_WIDGETS } from "../dashboard-config";

describe("journey roles", () => {
  it("maps IT roles to the it owner only", () => {
    expect(ownersForRole("it_manager")).toEqual(["it"]);
    expect(ownersForRole("it_technician")).toEqual(["it"]);
  });

  it("lets a manager act on sales, manager and ops steps", () => {
    expect(ownersForRole("manager").sort()).toEqual(["manager", "ops", "sales"]);
  });

  it("gives roles with no journey steps nothing", () => {
    expect(ownersForRole("fms")).toEqual([]);
    expect(ownersForRole("viewer")).toEqual([]);
  });

  it("only offers the widget to roles that own a step", () => {
    const withWidget = (Object.keys(DASHBOARD_ROLE_WIDGETS) as (keyof typeof DASHBOARD_ROLE_WIDGETS)[]).filter((r) =>
      DASHBOARD_ROLE_WIDGETS[r].includes("next_steps"),
    );
    expect(withWidget.length).toBeGreaterThan(0);
    for (const r of withWidget) expect(ownersForRole(r).length).toBeGreaterThan(0);
  });

  it("every owner has at least one role", () => {
    for (const roles of Object.values(OWNER_ROLES)) expect(roles.length).toBeGreaterThan(0);
  });
});
