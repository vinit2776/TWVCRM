/**
 * Messaging channel health evaluation.
 *
 * The thresholds here are calibrated against two real outages:
 *   - 2–26 Jul 2026: ~1700 WhatsApp sends failed with "WhatsApp not
 *     integrated" (trailing newline on the sender env var).
 *   - 7–15 Aug 2026: 178 sends failed with "no subscription assigned" (the
 *     MSG91 WhatsApp plan expired). Nine days, 100% failure, no alert.
 *
 * Both were 100%-failure events, so the tests below anchor on that shape and
 * on the boundaries either side of it. The drift guard at the bottom is the
 * one that matters most long-term: it fails the build when someone adds a
 * WhatsApp template without adding it to the monitored list.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateChannel,
  shouldAlert,
  diagnoseError,
  findTemplateIssues,
  MONITORED_WA_TEMPLATES,
  MIN_SAMPLE_SIZE,
  type MessageRow,
  type ChannelStatus,
} from "@/lib/messaging-health";

const rows = (spec: Array<[status: string, error?: string]>): MessageRow[] =>
  spec.map(([status, error]) => ({ status, error_message: error ?? null }));

const many = (n: number, status: string, error?: string): MessageRow[] =>
  rows(Array.from({ length: n }, () => [status, error] as [string, string?]));

describe("evaluateChannel", () => {
  it("reports idle below the minimum sample size rather than alarming", () => {
    // Four failures overnight is not an outage — it is four sends.
    const r = evaluateChannel(many(4, "failed", "boom"));
    expect(r.status).toBe("idle");
    expect(r.sampleSize).toBe(4);
  });

  it("reports idle for a completely silent window", () => {
    const r = evaluateChannel([]);
    expect(r.status).toBe("idle");
    expect(r.failRate).toBe(0);
  });

  it("flags a total outage as down", () => {
    // The 7 Aug 2026 shape.
    const r = evaluateChannel(
      many(25, "failed", 'HTTP 400: "There is no subscription assigned to this number: 917200001638"')
    );
    expect(r.status).toBe("down");
    expect(r.failRate).toBe(1);
    expect(r.failedCount).toBe(25);
    expect(r.diagnosis).toMatch(/plan has expired/i);
  });

  it("flags a partial outage as degraded", () => {
    const r = evaluateChannel([...many(5, "failed", "boom"), ...many(5, "delivered")]);
    expect(r.status).toBe("degraded");
    expect(r.failRate).toBe(0.5);
  });

  it("treats a healthy channel with occasional blips as ok", () => {
    const r = evaluateChannel([...many(1, "failed", "blip"), ...many(19, "delivered")]);
    expect(r.status).toBe("ok");
  });

  it("counts delivered, read and sent alike — only 'failed' is a failure", () => {
    const r = evaluateChannel([
      ...many(4, "delivered"),
      ...many(3, "read"),
      ...many(3, "sent"),
    ]);
    expect(r.status).toBe("ok");
    expect(r.failedCount).toBe(0);
  });

  it("picks the most frequent error, not the first or last", () => {
    const r = evaluateChannel([
      ...many(2, "failed", "rare network error"),
      ...many(8, "failed", "no subscription assigned to this number"),
    ]);
    expect(r.dominantError).toMatch(/no subscription/);
  });

  it("survives failures that carry no error message", () => {
    const r = evaluateChannel(many(10, "failed"));
    expect(r.status).toBe("down");
    expect(r.dominantError).toBeNull();
    expect(r.diagnosis).toBeNull();
  });

  it("evaluates exactly at the minimum sample size", () => {
    const r = evaluateChannel(many(MIN_SAMPLE_SIZE, "failed", "boom"));
    expect(r.status).toBe("down");
  });
});

describe("shouldAlert", () => {
  const cases: Array<[ChannelStatus | null, ChannelStatus, boolean, string]> = [
    [null,       "down",     true,  "first observation of an outage"],
    [null,       "ok",       false, "first observation of a healthy channel"],
    ["ok",       "down",     true,  "healthy -> outage"],
    ["ok",       "degraded", true,  "healthy -> degraded"],
    ["down",     "down",     false, "sustained outage must not re-alert"],
    ["down",     "ok",       true,  "recovery is worth announcing"],
    ["degraded", "down",     true,  "worsening within bad states"],
    ["down",     "degraded", true,  "improving but still bad"],
    ["ok",       "ok",       false, "steady state"],
    ["ok",       "idle",     false, "traffic stopping overnight is not an incident"],
    ["down",     "idle",     false, "no traffic cannot confirm recovery"],
    [null,       "idle",     false, "cold start with no traffic"],
  ];

  for (const [prev, next, expected, why] of cases) {
    it(`${expected ? "alerts" : "stays silent"}: ${why} (${prev ?? "none"} -> ${next})`, () => {
      expect(shouldAlert(prev, next)).toBe(expected);
    });
  }
});

describe("diagnoseError", () => {
  it("identifies an expired MSG91 plan", () => {
    expect(diagnoseError('HTTP 400: "There is no subscription assigned to this number: 917200001638"'))
      .toMatch(/plan has expired/i);
  });

  it("identifies an unrecognised sender number", () => {
    expect(diagnoseError('"WhatsApp not integrated: 917200001638\\n"')).toMatch(/stray whitespace/i);
  });

  it("identifies a newline in a template parameter", () => {
    expect(diagnoseError('HTTP 400: "next line(\\n) is not supported for body value"'))
      .toMatch(/newline or tab/i);
  });

  it("identifies a transport failure", () => {
    expect(diagnoseError("TypeError: fetch failed")).toMatch(/network error/i);
  });

  it("returns null for an unknown error so the raw text is shown instead", () => {
    expect(diagnoseError("something entirely new")).toBeNull();
    expect(diagnoseError(null)).toBeNull();
  });
});

describe("findTemplateIssues", () => {
  const approved = MONITORED_WA_TEMPLATES.map((name) => ({ name, status: "approved" }));

  it("returns nothing when every monitored template is approved", () => {
    expect(findTemplateIssues(approved)).toEqual([]);
  });

  it("flags a rejected template with its reason", () => {
    // The real state of booking_access_pin as of Aug 2026.
    const issues = findTemplateIssues([
      ...approved,
      { name: "booking_access_pin", status: "rejected", rejectionReason: "INCORRECT_CATEGORY" },
    ], ["booking_access_pin"]);
    expect(issues).toEqual([
      { name: "booking_access_pin", status: "rejected", reason: "INCORRECT_CATEGORY" },
    ]);
  });

  it("flags a monitored template missing from MSG91 entirely", () => {
    const issues = findTemplateIssues(approved.slice(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("missing");
  });

  it("flags a template that is approved but disabled", () => {
    const issues = findTemplateIssues([
      ...approved.slice(1),
      { name: MONITORED_WA_TEMPLATES[0], status: "approved", disabled: true },
    ]);
    expect(issues).toEqual([
      { name: MONITORED_WA_TEMPLATES[0], status: "disabled", reason: "Disabled in MSG91" },
    ]);
  });

  it("flags a pending template", () => {
    const issues = findTemplateIssues([...approved.slice(1), { name: MONITORED_WA_TEMPLATES[0], status: "pending" }]);
    expect(issues[0]).toMatchObject({ status: "pending" });
  });

  it("ignores extra templates in MSG91 that the code never sends", () => {
    expect(findTemplateIssues([...approved, { name: "some_orphan", status: "rejected" }])).toEqual([]);
  });

  it("ignores empty env-driven names rather than reporting them missing", () => {
    expect(findTemplateIssues(approved, ["", ""])).toEqual([]);
  });
});

/**
 * Drift guard.
 *
 * MONITORED_WA_TEMPLATES is a hand-maintained list, which means it can fall
 * behind the code it is supposed to watch. This reads the actual source and
 * fails if a `template: "..."` literal appears that is neither monitored nor
 * explicitly accounted for below — so adding a new WhatsApp template without
 * monitoring it breaks the build instead of creating a blind spot.
 */
describe("monitored template list stays in sync with whatsapp.ts", () => {
  // DLT *SMS* template keys, passed as `template:` in sendTemplate's SMS
  // fallback argument. Not WhatsApp templates, so not part of this audit.
  const DLT_KEYS = new Set([
    "otp", "booking", "contract_welcome", "contract_renewal",
    "payment_reminder", "payment_followup", "access_pin",
  ]);

  // WhatsApp templates intentionally not monitored, with the reason.
  const EXEMPT = new Set([
    // Rejected by Meta (INCORRECT_CATEGORY); its only call site is commented
    // out in provision-booking-access.ts. Delivery goes via DLT SMS + email.
    "booking_access_pin",
  ]);

  /**
   * Templates are sent from anywhere, not just whatsapp.ts — e.g.
   * lead_followup_reminder is sent straight from the lead-reminder-whatsapp
   * cron. Scanning only the wrapper file would miss those, so walk src/.
   */
  function sourceLiterals(): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(path, "utf8").matchAll(/\btemplate:\s*"([a-z0-9_]+)"/g)) {
            found.add(m[1]);
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    return found;
  }

  it("every template literal in the codebase is monitored or exempt", () => {
    const literals = sourceLiterals();
    expect(literals.size).toBeGreaterThan(0);

    const unmonitored = [...literals].filter(
      (t) => !MONITORED_WA_TEMPLATES.includes(t as (typeof MONITORED_WA_TEMPLATES)[number])
        && !DLT_KEYS.has(t)
        && !EXEMPT.has(t)
    );
    expect(unmonitored).toEqual([]);
  });

  it("does not monitor templates that no longer exist in the code", () => {
    const literals = sourceLiterals();
    const stale = MONITORED_WA_TEMPLATES.filter((t) => !literals.has(t));
    expect(stale).toEqual([]);
  });
});
