import { describe, it, expect } from "vitest";
import { personLabel } from "../person-label";

describe("personLabel", () => {
  it("says You for the signed-in user and the name for anyone else", () => {
    expect(personLabel({ id: "u1", name: "Priya" }, "u1")).toBe("You");
    expect(personLabel({ id: "u2", name: "Priya" }, "u1")).toBe("Priya");
  });
  it("never says You when nobody is signed in or the person has no id", () => {
    expect(personLabel({ id: "u1", name: "Priya" }, null)).toBe("Priya");
    expect(personLabel({ name: "Priya" }, "u1")).toBe("Priya");
  });
  it("falls back when there is no name", () => {
    expect(personLabel({ id: "u2", name: " " }, "u1")).toBe("Someone");
  });
});
