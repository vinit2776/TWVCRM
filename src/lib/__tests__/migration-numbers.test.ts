import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
// The checker is a CI script, but its comparison logic is pure and worth
// pinning — a false negative here means a silently skipped migration.
import { numberOf, byNumber, findConflicts } from "../../../.github/scripts/check-migration-numbers.mjs";

describe("numberOf", () => {
  it("reads the five-digit prefix", () => {
    expect(numberOf("00511_delivery_receipt_reversal.sql")).toBe("00511");
  });

  it("ignores anything that is not NNNNN_*.sql", () => {
    expect(numberOf("README.md")).toBeNull();
    expect(numberOf("0051_too_short.sql")).toBeNull();
    expect(numberOf("00511.sql")).toBeNull();
  });
});

describe("byNumber", () => {
  it("groups files sharing a number", () => {
    const m = byNumber(["00511_a.sql", "00511_b.sql", "00512_c.sql"]);
    expect(m.get("00511")?.size).toBe(2);
    expect(m.get("00512")?.size).toBe(1);
  });

  it("counts the identical filename once", () => {
    expect(byNumber(["00511_a.sql", "00511_a.sql"]).get("00511")?.size).toBe(1);
  });
});

describe("findConflicts", () => {
  const introduced = [{ file: "00511_delivery_receipt_reversal.sql", number: "00511" }];

  it("flags a different file claiming the same number", () => {
    // The real 00511 collision: two branches, neither yet on main.
    const claims = new Map([["00511", [
      { file: "00511_backfill_deposit_payment_medium.sql", where: "origin/fix/deposit-payment-medium-on-webhook" },
    ]]]);
    const [c] = findConflicts(introduced, claims);
    expect(c.number).toBe("00511");
    expect(c.theirs).toBe("00511_backfill_deposit_payment_medium.sql");
    expect(c.where).toContain("deposit-payment-medium");
  });

  it("does not flag the same file appearing on another branch", () => {
    // Shared history, not a collision — this is why every PR doesn't fail.
    const claims = new Map([["00511", [
      { file: "00511_delivery_receipt_reversal.sql", where: "origin/some/other-branch" },
    ]]]);
    expect(findConflicts(introduced, claims)).toEqual([]);
  });

  it("does not flag a number this branch does not introduce", () => {
    // The repo carries legacy cross-branch collisions on dead branches; they
    // must not fail builds that never touch those numbers.
    const claims = new Map([["00143", [
      { file: "00143_facility_issue_collaborators.sql", where: "origin/stale" },
    ]]]);
    expect(findConflicts(introduced, claims)).toEqual([]);
  });

  it("reports every branch contesting the number, not just the first", () => {
    const claims = new Map([["00511", [
      { file: "00511_x.sql", where: "origin/a" },
      { file: "00511_y.sql", where: "origin/b" },
    ]]]);
    expect(findConflicts(introduced, claims)).toHaveLength(2);
  });
});

describe("importing the checker", () => {
  // The script both exports helpers and runs the check. Before the main-guard,
  // importing it ran the check too — so a single real collision anywhere in the
  // repo would call process.exit(1) inside vitest and kill the whole suite,
  // reported as an unrelated test failure. Assert the import stays silent.
  it("has no side effects", () => {
    const out = execFileSync(
      process.execPath,
      ["-e", "import('./.github/scripts/check-migration-numbers.mjs').then(m => { if (!m.numberOf) process.exit(3); })"],
      { encoding: "utf8", cwd: process.cwd() },
    );
    expect(out).toBe("");
  });
});
