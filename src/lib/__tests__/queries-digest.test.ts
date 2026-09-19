import { describe, it, expect } from "vitest";
import {
  buildQueryDigest,
  DIGEST_LOOKBACK_HOURS,
  type DigestCandidate,
  type DigestMessage,
  type DigestThread,
} from "@/lib/queries/digest";
import { queryEntityDef } from "@/lib/queries/registry";
import type { QueryTargeting } from "@/lib/queries/types";

/**
 * The daily digest replaces one email per event with one email per person.
 * These pin down who lands on whose list, and what status they see — the rules
 * come from resolveRecipients()/decideChase(), so this is about the folding.
 */

const NOW = new Date("2026-09-19T04:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

// billing_statement: accounts / manager / sales_rep are paged, admin only watches.
const ENTITY = "billing_statement";
const ALL: QueryTargeting = { audience: "all", audience_roles: [], audience_user_ids: [] };
const TO_PRIYA: QueryTargeting = { audience: "users", audience_roles: [], audience_user_ids: ["priya"] };

const people: DigestCandidate[] = [
  { id: "meera", role: "accounts", email: "meera@example.com" },
  { id: "priya", role: "sales_rep", email: "priya@example.com" },
  { id: "arun", role: "manager", email: "arun@example.com" },
  { id: "vinit", role: "admin", email: "vinit@example.com" },
];

let seq = 0;
function msg(by: string, hAgo: number, over: Partial<DigestMessage> = {}): DigestMessage {
  return { id: `m${++seq}`, created_by: by, created_at: hoursAgo(hAgo), event_type: "message", body: "hello", ...over };
}

function thread(over: Partial<DigestThread> = {}): DigestThread {
  return {
    id: "q1",
    entity_type: ENTITY,
    entity_id: "e1",
    created_by: "meera",
    created_at: hoursAgo(200),
    status: "open",
    kind: "question",
    needed_by: null,
    escalated_at: null,
    last_nudged_at: null,
    targeting: ALL,
    messages: [msg("meera", 200)],
    ...over,
  };
}

const build = (threads: DigestThread[]) => buildQueryDigest({ threads, candidates: people, now: NOW });
const kinds = (digest: ReturnType<typeof build>, id: string) =>
  (digest.byRecipient.get(id) ?? []).flatMap((i) => i.badges.map((b) => b.kind));

describe("registry assumption", () => {
  it("billing_statement pages accounts, manager and sales_rep but not admin", () => {
    const def = queryEntityDef(ENTITY)!;
    expect(def.alertRoles).toEqual(expect.arrayContaining(["accounts", "manager", "sales_rep"]));
    expect(def.alertRoles).not.toContain("admin");
  });
});

describe("a quiet thread", () => {
  it("produces nothing — no activity in the window, not overdue, not silent long enough", () => {
    const d = build([thread({ created_at: hoursAgo(30), messages: [msg("meera", 30)] })]);
    expect(d.byRecipient.size).toBe(0);
    expect(d.chased).toHaveLength(0);
  });

  it("leaves resolved threads with no recent events alone", () => {
    const d = build([thread({ status: "resolved", needed_by: "2026-09-01", messages: [msg("meera", 500)] })]);
    expect(d.byRecipient.size).toBe(0);
  });
});

describe("a new query", () => {
  const d = build([thread({ created_at: hoursAgo(3), messages: [msg("meera", 3, { body: "Which ledger?" })] })]);

  it("shows as New to the people who would have been paged", () => {
    expect(kinds(d, "priya")).toEqual(["new"]);
    expect(kinds(d, "arun")).toEqual(["new"]);
  });

  it("does not list it for the asker or for monitoring-only admin", () => {
    expect(d.byRecipient.has("meera")).toBe(false);
    expect(d.byRecipient.has("vinit")).toBe(false);
  });

  it("does not double-count the opening message as a reply", () => {
    expect(kinds(d, "priya")).not.toContain("replied");
  });

  it("carries who asked, so the email can name them", () => {
    expect(d.byRecipient.get("priya")![0].askerId).toBe("meera");
  });

  it("marks it as awaiting the recipient", () => {
    expect(d.byRecipient.get("priya")![0].awaitingYou).toBe(true);
  });
});

describe("replies", () => {
  const t = thread({
    created_at: hoursAgo(100),
    messages: [msg("meera", 100), msg("priya", 5, { body: "It goes to rent." }), msg("arun", 2, { body: "Agreed." })],
  });
  const d = build([t]);

  it("collapses several replies into one badge with a count", () => {
    const item = d.byRecipient.get("meera")![0];
    expect(item.badges.map((b) => b.label)).toEqual(["2 new replies"]);
  });

  it("previews the latest reply from someone else", () => {
    expect(d.byRecipient.get("meera")![0].latestReply).toBe("Agreed.");
    expect(d.byRecipient.get("arun")![0].latestReply).toBe("It goes to rent.");
  });

  it("never reports your own replies back to you", () => {
    expect(d.byRecipient.get("priya")![0].badges.map((b) => b.label)).toEqual(["1 new reply"]);
  });

  it("ignores replies older than the window", () => {
    const old = thread({
      created_at: hoursAgo(300),
      messages: [msg("meera", 300), msg("priya", DIGEST_LOOKBACK_HOURS + 5)],
    });
    expect(build([old]).byRecipient.size).toBe(0);
  });
});

describe("thread state changes", () => {
  it("tells the asker their thread was resolved", () => {
    const t = thread({
      status: "resolved",
      messages: [msg("meera", 100), msg("priya", 4, { body: "Done" }), msg("priya", 3, { event_type: "resolved", body: null })],
    });
    const d = build([t]);
    expect(kinds(d, "meera")).toEqual(expect.arrayContaining(["resolved"]));
    expect(d.byRecipient.get("meera")![0].awaitingYou).toBe(false);
  });

  it("reports a payment verdict", () => {
    const t = thread({
      status: "resolved",
      messages: [msg("meera", 100), msg("priya", 2, { event_type: "payment_verified", body: null })],
    });
    expect(kinds(build([t]), "meera")).toContain("payment_verified");
  });
});

describe("overdue and silent threads", () => {
  it("flags an overdue thread with its day count, for someone who owes an answer", () => {
    const t = thread({ needed_by: "2026-09-16", messages: [msg("meera", 30)] });
    const d = build([t]);
    expect(d.byRecipient.get("priya")![0].badges[0]).toEqual({ kind: "overdue", label: "Overdue 3 days" });
    expect(d.chased.map((c) => c.kind)).toEqual(["nudge"]);
  });

  it("never chases the asker about their own question", () => {
    const t = thread({ needed_by: "2026-09-10", messages: [msg("meera", 30)] });
    expect(build([t]).byRecipient.has("meera")).toBe(false);
  });

  it("escalates a thread that has gone quiet for 48h, showing how long", () => {
    const t = thread({ messages: [msg("meera", 100)] });
    const d = build([t]);
    expect(d.byRecipient.get("priya")![0].badges[0]).toEqual({ kind: "escalated", label: "No reply for 4 days" });
    expect(d.chased.map((c) => c.kind)).toEqual(["escalate"]);
  });

  it("does not re-escalate a stretch of silence that was already escalated", () => {
    const t = thread({ messages: [msg("meera", 100)], escalated_at: hoursAgo(30) });
    expect(build([t]).chased).toHaveLength(0);
  });

  it("puts overdue and silent badges together, most urgent first", () => {
    const t = thread({ needed_by: "2026-09-16", messages: [msg("meera", 100)] });
    const badges = build([t]).byRecipient.get("priya")![0].badges.map((b) => b.kind);
    expect(badges).toEqual(["escalated", "overdue"]);
  });

  it("widens to admin once well past due, even though admin is not normally paged", () => {
    const t = thread({ needed_by: "2026-09-10", messages: [msg("meera", 30)] });
    const d = build([t]);
    expect(d.byRecipient.has("vinit")).toBe(true);
    expect(d.chased[0].recipientIds).toContain("vinit");
  });

  it("keeps admin off a thread that is only slightly overdue", () => {
    const t = thread({ needed_by: "2026-09-18", messages: [msg("meera", 30)] });
    expect(build([t]).byRecipient.has("vinit")).toBe(false);
  });

  it("does not let its own nudge marker read as the asker replying", () => {
    const t = thread({
      needed_by: "2026-09-16",
      messages: [msg("meera", 100), msg("meera", 30, { event_type: "nudged", body: null })],
    });
    const d = build([t]);
    expect(d.byRecipient.get("priya")![0].badges.map((b) => b.kind)).toEqual(["overdue"]);
    expect(d.byRecipient.get("priya")![0].latestReply).toBeNull();
  });
});

describe("targeting", () => {
  it("emails only the named person on a targeted thread", () => {
    const t = thread({ targeting: TO_PRIYA, created_at: hoursAgo(3), messages: [msg("meera", 3)] });
    const d = build([t]);
    expect([...d.byRecipient.keys()]).toEqual(["priya"]);
  });

  it("keeps a prior participant in the loop after a re-target", () => {
    const t = thread({
      targeting: TO_PRIYA,
      created_at: hoursAgo(100),
      messages: [msg("meera", 100), msg("arun", 90, { body: "Looking" }), msg("meera", 2, { event_type: "retargeted", body: null })],
    });
    const d = build([t]);
    expect(d.byRecipient.has("arun")).toBe(true);
    expect(kinds(d, "priya")).toContain("rerouted");
  });
});

describe("one list per person", () => {
  it("gathers several threads into a single list, most urgent first", () => {
    const overdue = thread({ id: "q-old", needed_by: "2026-09-15", created_at: hoursAgo(300), messages: [msg("meera", 30)] });
    const fresh = thread({ id: "q-new", created_at: hoursAgo(2), messages: [msg("meera", 2)] });
    const d = build([fresh, overdue]);
    expect(d.byRecipient.get("priya")!.map((i) => i.queryId)).toEqual(["q-old", "q-new"]);
  });

  it("skips entity types the registry does not know", () => {
    expect(build([thread({ entity_type: "nope", created_at: hoursAgo(1), messages: [msg("meera", 1)] })]).byRecipient.size).toBe(0);
  });
});
