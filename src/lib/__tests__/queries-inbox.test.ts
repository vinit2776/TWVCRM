import { describe, expect, it } from "vitest";
import { isThreadUnread, isWaitingOnOthers } from "@/lib/queries/audience";
import { QUERY_ENTITIES } from "@/lib/queries/registry";
import type { UserRole } from "@/types";

const def = QUERY_ENTITIES.billing_statement;
const base = {
  status: "open" as const,
  audience: "roles" as const,
  audience_roles: ["accounts"] as UserRole[],
  audience_user_ids: [] as string[],
  created_by_id: "asker",
  last_message_author_id: "asker" as string | null,
  message_author_ids: ["asker"],
};

describe("isWaitingOnOthers", () => {
  it("is true for the asker while the answer is pending", () => {
    expect(isWaitingOnOthers(base, def, { id: "asker", role: "sales_rep" })).toBe(true);
  });
  it("is false when it is your move", () => {
    expect(isWaitingOnOthers(base, def, { id: "acct", role: "accounts" })).toBe(false);
  });
  it("is true for someone who answered and now waits", () => {
    const q = { ...base, last_message_author_id: "acct", message_author_ids: ["asker", "acct"] };
    expect(isWaitingOnOthers(q, def, { id: "acct", role: "accounts" })).toBe(true);
  });
  it("is false for a stranger and for resolved threads", () => {
    expect(isWaitingOnOthers(base, def, { id: "x", role: "floor_manager" })).toBe(false);
    expect(isWaitingOnOthers({ ...base, status: "resolved" as never }, def, { id: "asker", role: "sales_rep" })).toBe(false);
  });
});

describe("isThreadUnread", () => {
  const p = {
    lastMessageAt: "2026-11-02T10:00:00Z",
    lastMessageAuthorId: "other",
    viewerId: "me",
    lastReadAt: null as string | null,
    effectiveFrom: "2026-11-01T00:00:00Z",
  };
  it("flags a reply never opened", () => expect(isThreadUnread(p)).toBe(true));
  it("clears once opened after the reply", () =>
    expect(isThreadUnread({ ...p, lastReadAt: "2026-11-02T10:05:00Z" })).toBe(false));
  it("flags a reply newer than the last open", () =>
    expect(isThreadUnread({ ...p, lastReadAt: "2026-11-02T09:00:00Z" })).toBe(true));
  it("ignores your own message", () => expect(isThreadUnread({ ...p, lastMessageAuthorId: "me" })).toBe(false));
  it("ignores history before the cutoff, and a missing cutoff", () => {
    expect(isThreadUnread({ ...p, lastMessageAt: "2026-10-30T10:00:00Z" })).toBe(false);
    expect(isThreadUnread({ ...p, effectiveFrom: null })).toBe(false);
  });
});
